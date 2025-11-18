# Phase 7: Admin Dashboard 구축 가이드

## 목차
1. [개요](#개요)
2. [Admin 인증 및 권한 관리](#admin-인증-및-권한-관리)
3. [사용자 관리 API](#사용자-관리-api)
4. [모델 관리 시스템](#모델-관리-시스템)
5. [시스템 통계 대시보드](#시스템-통계-대시보드)
6. [관리자 감사 로그](#관리자-감사-로그)
7. [Admin Frontend UI](#admin-frontend-ui)
8. [보안 고려사항](#보안-고려사항)
9. [테스트](#테스트)

---

## 개요

Phase 7에서는 시스템 전체를 관리할 수 있는 Admin Dashboard를 구축합니다.

### 주요 기능
- **사용자 관리**: 전체 사용자 조회, 플랜 변경, 계정 정지/활성화, 크레딧 수동 조정
- **모델 관리**: 커스텀 모델 업로드, 모델 활성화/비활성화, 티어별 접근 제어
- **시스템 통계**: 매출, 사용자 수, 크레딧 사용량, 스토리지 현황
- **감사 로그**: 모든 관리자 작업 기록 및 추적
- **보안**: Role-based access control, IP 화이트리스트, 2FA

### 기술 스택
- **Backend**: FastAPI, SQLAlchemy (PostgreSQL)
- **Frontend**: React 18 + TypeScript + Redux
- **Charts**: Recharts, Chart.js
- **Tables**: React Table v8
- **Security**: JWT + 2FA (TOTP)

---

## Admin 인증 및 권한 관리

### 1. Database Schema

```sql
-- users 테이블에 admin 관련 필드 추가
ALTER TABLE users ADD COLUMN is_superuser BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN is_staff BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN admin_role VARCHAR(50);  -- superadmin, admin, support
ALTER TABLE users ADD COLUMN totp_secret VARCHAR(255);  -- 2FA secret
ALTER TABLE users ADD COLUMN is_2fa_enabled BOOLEAN DEFAULT FALSE;

-- Admin 권한 테이블
CREATE TABLE admin_roles (
    role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_name VARCHAR(50) UNIQUE NOT NULL,  -- superadmin, admin, support
    description TEXT,
    permissions JSONB NOT NULL,  -- {"users": ["read", "write"], "models": ["read"]}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 기본 역할 삽입
INSERT INTO admin_roles (role_name, description, permissions) VALUES
('superadmin', 'Full system access', '{
    "users": ["read", "write", "delete"],
    "subscriptions": ["read", "write"],
    "models": ["read", "write", "delete"],
    "credits": ["read", "write"],
    "system": ["read", "write"]
}'),
('admin', 'Limited admin access', '{
    "users": ["read", "write"],
    "subscriptions": ["read"],
    "models": ["read", "write"],
    "credits": ["read", "write"],
    "system": ["read"]
}'),
('support', 'Support staff access', '{
    "users": ["read"],
    "subscriptions": ["read"],
    "models": ["read"],
    "credits": ["read"],
    "system": ["read"]
}');

-- Admin IP 화이트리스트
CREATE TABLE admin_ip_whitelist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_address INET NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(user_id)
);

CREATE INDEX idx_admin_ip_whitelist_ip ON admin_ip_whitelist(ip_address) WHERE is_active = TRUE;
```

### 2. Admin 권한 체크 미들웨어

```python
# app/middleware/admin_auth.py
from fastapi import Request, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import List, Optional
import ipaddress

security = HTTPBearer()

class AdminPermission:
    """Admin 권한 체크 데코레이터"""

    def __init__(
        self,
        resource: str,  # "users", "models", "credits", etc.
        action: str,    # "read", "write", "delete"
        require_2fa: bool = True,
        check_ip_whitelist: bool = True
    ):
        self.resource = resource
        self.action = action
        self.require_2fa = require_2fa
        self.check_ip_whitelist = check_ip_whitelist

    async def __call__(self, request: Request, db: AsyncSession):
        # 1. JWT 토큰 검증
        credentials: HTTPAuthorizationCredentials = await security(request)
        token = credentials.credentials

        payload = verify_jwt_token(token)
        if not payload:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token"
            )

        user_id = payload.get("sub")

        # 2. 사용자 조회 및 Admin 권한 확인
        stmt = select(User).where(User.user_id == user_id)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()

        if not user or not user.is_staff:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin access required"
            )

        # 3. 2FA 확인
        if self.require_2fa and user.is_2fa_enabled:
            totp_token = request.headers.get("X-TOTP-Token")
            if not totp_token:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="2FA token required"
                )

            if not verify_totp(user.totp_secret, totp_token):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Invalid 2FA token"
                )

        # 4. IP 화이트리스트 확인
        if self.check_ip_whitelist:
            client_ip = request.client.host

            stmt = select(AdminIPWhitelist).where(
                AdminIPWhitelist.is_active == True
            )
            result = await db.execute(stmt)
            whitelisted_ips = result.scalars().all()

            if whitelisted_ips:  # 화이트리스트가 설정되어 있으면
                is_allowed = any(
                    ipaddress.ip_address(client_ip) in ipaddress.ip_network(wl.ip_address)
                    for wl in whitelisted_ips
                )

                if not is_allowed:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"IP {client_ip} not in whitelist"
                    )

        # 5. 역할별 권한 확인
        stmt = select(AdminRole).where(AdminRole.role_name == user.admin_role)
        result = await db.execute(stmt)
        role = result.scalar_one_or_none()

        if not role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invalid admin role"
            )

        permissions = role.permissions
        resource_permissions = permissions.get(self.resource, [])

        if self.action not in resource_permissions:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {self.resource}:{self.action}"
            )

        return user


def require_admin(
    resource: str,
    action: str,
    require_2fa: bool = True,
    check_ip_whitelist: bool = True
):
    """Admin 권한 체크 의존성"""
    return Depends(AdminPermission(resource, action, require_2fa, check_ip_whitelist))
```

### 3. 2FA (TOTP) 구현

```python
# app/services/totp_service.py
import pyotp
import qrcode
from io import BytesIO
import base64

class TOTPService:
    """TOTP 2FA 서비스"""

    @staticmethod
    def generate_secret() -> str:
        """TOTP secret 생성"""
        return pyotp.random_base32()

    @staticmethod
    def get_provisioning_uri(secret: str, email: str, issuer: str = "PingvasAI") -> str:
        """TOTP 앱용 URI 생성"""
        totp = pyotp.TOTP(secret)
        return totp.provisioning_uri(name=email, issuer_name=issuer)

    @staticmethod
    def generate_qr_code(uri: str) -> str:
        """QR 코드 생성 (base64 인코딩)"""
        qr = qrcode.QRCode(version=1, box_size=10, border=5)
        qr.add_data(uri)
        qr.make(fit=True)

        img = qr.make_image(fill_color="black", back_color="white")

        buffer = BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)

        img_base64 = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/png;base64,{img_base64}"

    @staticmethod
    def verify_token(secret: str, token: str) -> bool:
        """TOTP 토큰 검증"""
        totp = pyotp.TOTP(secret)
        return totp.verify(token, valid_window=1)  # ±30초 허용


# API 엔드포인트
@router.post("/admin/2fa/enable")
async def enable_2fa(
    current_user: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db)
):
    """2FA 활성화"""

    if current_user.is_2fa_enabled:
        raise HTTPException(400, "2FA already enabled")

    # Secret 생성
    secret = TOTPService.generate_secret()

    # QR 코드 생성
    uri = TOTPService.get_provisioning_uri(secret, current_user.email)
    qr_code = TOTPService.generate_qr_code(uri)

    # 임시 저장 (Redis 추천, 여기서는 DB 사용)
    current_user.totp_secret = secret
    await db.commit()

    return {
        "secret": secret,
        "qr_code": qr_code,
        "message": "Scan QR code with your authenticator app"
    }


@router.post("/admin/2fa/verify")
async def verify_2fa(
    token: str,
    current_user: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db)
):
    """2FA 토큰 검증 및 활성화 완료"""

    if not current_user.totp_secret:
        raise HTTPException(400, "2FA not initialized")

    if not TOTPService.verify_token(current_user.totp_secret, token):
        raise HTTPException(400, "Invalid token")

    # 2FA 활성화
    current_user.is_2fa_enabled = True
    await db.commit()

    return {"message": "2FA enabled successfully"}
```

---

## 사용자 관리 API

### 1. 사용자 목록 조회 (필터링, 페이지네이션)

```python
# app/api/v1/admin/users.py
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, or_
from sqlalchemy.orm import selectinload
from typing import Optional, List
from datetime import datetime, timedelta

router = APIRouter(prefix="/admin/users", tags=["Admin - Users"])


class UserListFilters(BaseModel):
    """사용자 목록 필터"""
    search: Optional[str] = None  # email, username 검색
    subscription_plan: Optional[str] = None  # free, starter, pro, studio, enterprise
    subscription_status: Optional[str] = None  # active, cancelled, expired
    is_active: Optional[bool] = None
    registered_after: Optional[datetime] = None
    registered_before: Optional[datetime] = None
    min_credits: Optional[int] = None
    max_credits: Optional[int] = None
    sort_by: str = "created_at"  # created_at, email, credits_balance
    sort_order: str = "desc"  # asc, desc


@router.get("/", response_model=PaginatedResponse[AdminUserDetail])
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    filters: UserListFilters = Depends(),
    current_admin: User = Depends(require_admin("users", "read")),
    db: AsyncSession = Depends(get_db)
):
    """
    사용자 목록 조회 (Admin)

    **필터 옵션:**
    - search: 이메일/사용자명 검색
    - subscription_plan: 구독 플랜 필터
    - subscription_status: 구독 상태 필터
    - is_active: 계정 활성화 상태
    - registered_after/before: 가입일 범위
    - min_credits/max_credits: 크레딧 잔액 범위
    """

    # Base query
    stmt = select(User).options(
        selectinload(User.subscription_history)
    )

    # 필터 적용
    conditions = []

    if filters.search:
        search_pattern = f"%{filters.search}%"
        conditions.append(
            or_(
                User.email.ilike(search_pattern),
                User.username.ilike(search_pattern)
            )
        )

    if filters.subscription_plan:
        conditions.append(User.subscription_plan == filters.subscription_plan)

    if filters.subscription_status:
        conditions.append(User.subscription_status == filters.subscription_status)

    if filters.is_active is not None:
        conditions.append(User.is_active == filters.is_active)

    if filters.registered_after:
        conditions.append(User.created_at >= filters.registered_after)

    if filters.registered_before:
        conditions.append(User.created_at <= filters.registered_before)

    if filters.min_credits is not None:
        conditions.append(User.credits_balance >= filters.min_credits)

    if filters.max_credits is not None:
        conditions.append(User.credits_balance <= filters.max_credits)

    if conditions:
        stmt = stmt.where(*conditions)

    # 정렬
    sort_column = getattr(User, filters.sort_by, User.created_at)
    if filters.sort_order == "desc":
        stmt = stmt.order_by(sort_column.desc())
    else:
        stmt = stmt.order_by(sort_column.asc())

    # 총 개수 조회
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total_result = await db.execute(count_stmt)
    total = total_result.scalar()

    # 페이지네이션
    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size)

    result = await db.execute(stmt)
    users = result.scalars().all()

    return PaginatedResponse(
        items=users,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size
    )
```

### 2. 사용자 상세 정보

```python
@router.get("/{user_id}", response_model=AdminUserDetail)
async def get_user_detail(
    user_id: str,
    current_admin: User = Depends(require_admin("users", "read")),
    db: AsyncSession = Depends(get_db)
):
    """사용자 상세 정보 조회 (Admin)"""

    stmt = select(User).options(
        selectinload(User.subscription_history),
        selectinload(User.credit_transactions),
        selectinload(User.images)
    ).where(User.user_id == user_id)

    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(404, "User not found")

    # 추가 통계 계산
    # 1. 이번 달 크레딧 사용량
    month_start = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_credits_stmt = select(func.sum(CreditTransaction.credits)).where(
        CreditTransaction.user_id == user_id,
        CreditTransaction.created_at >= month_start,
        CreditTransaction.transaction_type == "usage"
    )
    month_credits_result = await db.execute(month_credits_stmt)
    month_credits_used = month_credits_result.scalar() or 0

    # 2. 총 생성 이미지 수
    total_images_stmt = select(func.count()).where(Image.user_id == user_id)
    total_images_result = await db.execute(total_images_stmt)
    total_images = total_images_result.scalar()

    # 3. 스토리지 사용량
    storage_stmt = select(StorageUsage).where(StorageUsage.user_id == user_id)
    storage_result = await db.execute(storage_stmt)
    storage = storage_result.scalar_one_or_none()

    # 4. 최근 활동 (마지막 이미지 생성일)
    last_activity_stmt = select(func.max(Image.created_at)).where(Image.user_id == user_id)
    last_activity_result = await db.execute(last_activity_stmt)
    last_activity = last_activity_result.scalar()

    return AdminUserDetail(
        **user.__dict__,
        month_credits_used=month_credits_used,
        total_images=total_images,
        storage_used_mb=storage.total_size_mb if storage else 0,
        last_activity_at=last_activity
    )
```

### 3. 구독 플랜 수동 변경

```python
class SubscriptionChangeRequest(BaseModel):
    new_plan: str  # free, starter, pro, studio, enterprise
    reason: str
    notify_user: bool = True


@router.post("/{user_id}/change-subscription")
async def change_user_subscription(
    user_id: str,
    request: SubscriptionChangeRequest,
    current_admin: User = Depends(require_admin("subscriptions", "write")),
    db: AsyncSession = Depends(get_db)
):
    """
    사용자 구독 플랜 수동 변경 (Admin)

    **사용 사례:**
    - 고객 지원: 결제 문제 해결
    - 프로모션: 무료 업그레이드 제공
    - 환불: 다운그레이드 처리
    """

    # 1. 사용자 조회
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(404, "User not found")

    old_plan = user.subscription_plan

    # 2. 새로운 플랜 정보 가져오기
    new_plan_info = SUBSCRIPTION_PLANS.get(request.new_plan)
    if not new_plan_info:
        raise HTTPException(400, f"Invalid plan: {request.new_plan}")

    # 3. 구독 정보 업데이트
    user.subscription_plan = request.new_plan
    user.subscription_status = "active"

    # 플랜별 크레딧 부여
    if request.new_plan != "free":
        credits_to_add = new_plan_info["monthly_credits"]
        user.credits_balance += credits_to_add
        user.purchased_credits += credits_to_add

        # 크레딧 트랜잭션 기록
        credit_tx = CreditTransaction(
            user_id=user_id,
            credits=credits_to_add,
            transaction_type="purchase",
            description=f"Admin plan change: {old_plan} -> {request.new_plan}",
            metadata={
                "admin_id": str(current_admin.user_id),
                "reason": request.reason,
                "old_plan": old_plan,
                "new_plan": request.new_plan
            }
        )
        db.add(credit_tx)

    # 4. 구독 히스토리 기록
    subscription_history = SubscriptionHistory(
        user_id=user_id,
        subscription_plan=request.new_plan,
        status="active",
        started_at=datetime.utcnow(),
        metadata={
            "changed_by_admin": str(current_admin.user_id),
            "reason": request.reason,
            "previous_plan": old_plan
        }
    )
    db.add(subscription_history)

    # 5. 감사 로그 기록
    audit_log = AdminAuditLog(
        admin_user_id=current_admin.user_id,
        action="change_subscription",
        resource_type="user",
        resource_id=user_id,
        details={
            "old_plan": old_plan,
            "new_plan": request.new_plan,
            "reason": request.reason,
            "credits_added": new_plan_info.get("monthly_credits", 0) if request.new_plan != "free" else 0
        }
    )
    db.add(audit_log)

    await db.commit()

    # 6. 사용자에게 이메일 알림 (선택 사항)
    if request.notify_user:
        await send_subscription_change_email(
            user.email,
            old_plan=old_plan,
            new_plan=request.new_plan,
            reason=request.reason
        )

    return {
        "message": "Subscription changed successfully",
        "user_id": user_id,
        "old_plan": old_plan,
        "new_plan": request.new_plan,
        "credits_added": new_plan_info.get("monthly_credits", 0) if request.new_plan != "free" else 0
    }
```

### 4. 크레딧 수동 조정

```python
class CreditAdjustmentRequest(BaseModel):
    credits: int  # 양수: 추가, 음수: 차감
    reason: str
    notify_user: bool = True


@router.post("/{user_id}/adjust-credits")
async def adjust_user_credits(
    user_id: str,
    request: CreditAdjustmentRequest,
    current_admin: User = Depends(require_admin("credits", "write")),
    db: AsyncSession = Depends(get_db)
):
    """
    사용자 크레딧 수동 조정 (Admin)

    **사용 사례:**
    - 환불 처리
    - 보상 크레딧 지급
    - 오류 수정
    - 프로모션 크레딧
    """

    # 1. 사용자 조회
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(404, "User not found")

    old_balance = user.credits_balance

    # 2. 크레딧 차감 시 잔액 확인
    if request.credits < 0 and user.credits_balance < abs(request.credits):
        raise HTTPException(
            400,
            f"Insufficient credits. Current: {user.credits_balance}, Requested: {abs(request.credits)}"
        )

    # 3. 크레딧 조정
    user.credits_balance += request.credits

    if request.credits > 0:
        user.purchased_credits += request.credits

    # 4. 트랜잭션 기록
    transaction_type = "admin_credit" if request.credits > 0 else "admin_debit"

    credit_tx = CreditTransaction(
        user_id=user_id,
        credits=abs(request.credits),
        transaction_type=transaction_type,
        description=request.reason,
        metadata={
            "admin_id": str(current_admin.user_id),
            "old_balance": old_balance,
            "new_balance": user.credits_balance,
            "adjustment": request.credits
        }
    )
    db.add(credit_tx)

    # 5. 감사 로그
    audit_log = AdminAuditLog(
        admin_user_id=current_admin.user_id,
        action="adjust_credits",
        resource_type="user",
        resource_id=user_id,
        details={
            "credits_adjustment": request.credits,
            "reason": request.reason,
            "old_balance": old_balance,
            "new_balance": user.credits_balance
        }
    )
    db.add(audit_log)

    await db.commit()

    # 6. 이메일 알림
    if request.notify_user:
        await send_credit_adjustment_email(
            user.email,
            credits=request.credits,
            reason=request.reason,
            new_balance=user.credits_balance
        )

    return {
        "message": "Credits adjusted successfully",
        "user_id": user_id,
        "old_balance": old_balance,
        "adjustment": request.credits,
        "new_balance": user.credits_balance
    }
```

### 5. 계정 정지/활성화

```python
class AccountStatusRequest(BaseModel):
    is_active: bool
    reason: str
    notify_user: bool = True


@router.post("/{user_id}/status")
async def update_account_status(
    user_id: str,
    request: AccountStatusRequest,
    current_admin: User = Depends(require_admin("users", "write")),
    db: AsyncSession = Depends(get_db)
):
    """
    계정 활성화/정지 (Admin)

    **사용 사례:**
    - 이용약관 위반 시 정지
    - 계정 복구
    - 임시 차단
    """

    # 1. 사용자 조회
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(404, "User not found")

    # 자기 자신은 정지할 수 없음
    if user_id == str(current_admin.user_id):
        raise HTTPException(400, "Cannot suspend your own account")

    old_status = user.is_active

    # 2. 상태 변경
    user.is_active = request.is_active

    # 3. 정지된 경우 진행 중인 작업 취소
    if not request.is_active:
        # Celery 작업 취소
        pending_jobs_stmt = select(Job).where(
            Job.user_id == user_id,
            Job.status.in_(["pending", "processing"])
        )
        result = await db.execute(pending_jobs_stmt)
        pending_jobs = result.scalars().all()

        for job in pending_jobs:
            # Celery task revoke
            from app.worker import celery_app
            celery_app.control.revoke(str(job.job_id), terminate=True)

            job.status = "cancelled"
            job.error_message = f"Account suspended by admin: {request.reason}"

    # 4. 감사 로그
    audit_log = AdminAuditLog(
        admin_user_id=current_admin.user_id,
        action="update_account_status",
        resource_type="user",
        resource_id=user_id,
        details={
            "old_status": "active" if old_status else "suspended",
            "new_status": "active" if request.is_active else "suspended",
            "reason": request.reason
        }
    )
    db.add(audit_log)

    await db.commit()

    # 5. 이메일 알림
    if request.notify_user:
        if request.is_active:
            await send_account_reactivated_email(user.email, request.reason)
        else:
            await send_account_suspended_email(user.email, request.reason)

    return {
        "message": f"Account {'activated' if request.is_active else 'suspended'} successfully",
        "user_id": user_id,
        "is_active": request.is_active
    }
```

### 6. 사용자 삭제 (GDPR 준수)

```python
@router.delete("/{user_id}")
async def delete_user_account(
    user_id: str,
    reason: str,
    current_admin: User = Depends(require_admin("users", "delete")),
    db: AsyncSession = Depends(get_db)
):
    """
    사용자 계정 완전 삭제 (GDPR 준수)

    **삭제 항목:**
    - 사용자 정보
    - 모든 생성 이미지 (S3 포함)
    - 크레딧 트랜잭션
    - 구독 정보
    - 공유 링크
    """

    # 1. 사용자 조회
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(404, "User not found")

    # 자기 자신은 삭제할 수 없음
    if user_id == str(current_admin.user_id):
        raise HTTPException(400, "Cannot delete your own account")

    # 2. S3에서 모든 이미지 삭제
    s3_client = S3Client()
    images_stmt = select(Image).where(Image.user_id == user_id)
    images_result = await db.execute(images_stmt)
    images = images_result.scalars().all()

    for image in images:
        # S3 삭제
        s3_client.delete_file(image.s3_key)
        if image.thumbnail_256_key:
            s3_client.delete_file(image.thumbnail_256_key)
        if image.thumbnail_512_key:
            s3_client.delete_file(image.thumbnail_512_key)

    # 3. Elasticsearch에서 삭제
    es_client = ElasticsearchClient()
    await es_client.delete_user_documents(user_id)

    # 4. 감사 로그 (삭제 전 기록)
    audit_log = AdminAuditLog(
        admin_user_id=current_admin.user_id,
        action="delete_user",
        resource_type="user",
        resource_id=user_id,
        details={
            "email": user.email,
            "username": user.username,
            "subscription_plan": user.subscription_plan,
            "credits_balance": user.credits_balance,
            "total_images": len(images),
            "reason": reason
        }
    )
    db.add(audit_log)
    await db.flush()  # 감사 로그 먼저 커밋

    # 5. 데이터베이스에서 사용자 삭제 (CASCADE로 관련 데이터 자동 삭제)
    await db.delete(user)
    await db.commit()

    return {
        "message": "User account deleted successfully",
        "user_id": user_id,
        "deleted_images": len(images)
    }
```

---

## 모델 관리 시스템

### 1. Database Schema

```sql
-- AI 모델 테이블
CREATE TABLE ai_models (
    model_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name VARCHAR(255) UNIQUE NOT NULL,  -- flux-dev, flux-schnell, sd-xl-1.0
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    model_type VARCHAR(50) NOT NULL,  -- text-to-image, image-to-image, upscale
    base_model VARCHAR(100),  -- FLUX, Stable Diffusion, etc.
    version VARCHAR(50),
    s3_model_path VARCHAR(1000),  -- S3에 저장된 모델 파일 경로
    model_size_gb DECIMAL(10, 2),

    -- 접근 제어
    is_active BOOLEAN DEFAULT TRUE,
    is_public BOOLEAN DEFAULT FALSE,  -- 공개 모델 여부
    required_plan VARCHAR(50),  -- free, starter, pro, studio, enterprise
    min_plan_tier INTEGER DEFAULT 0,  -- 0: free, 1: starter, 2: pro, 3: studio, 4: enterprise

    -- 성능 메타데이터
    avg_generation_time_sec INTEGER,  -- 평균 생성 시간
    gpu_memory_gb DECIMAL(10, 2),
    supported_sizes JSONB,  -- ["512x512", "1024x1024"]
    max_batch_size INTEGER DEFAULT 1,

    -- 통계
    total_generations INTEGER DEFAULT 0,
    total_credits_consumed BIGINT DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(user_id)
);

CREATE INDEX idx_ai_models_active ON ai_models(is_active, required_plan);
CREATE INDEX idx_ai_models_type ON ai_models(model_type);

-- 기본 모델 데이터
INSERT INTO ai_models (model_name, display_name, description, model_type, base_model, version, required_plan, min_plan_tier, avg_generation_time_sec, gpu_memory_gb, supported_sizes) VALUES
('flux-schnell', 'FLUX Schnell', 'Fast generation model', 'text-to-image', 'FLUX', '1.0', 'free', 0, 3, 16, '["512x512", "768x768", "1024x1024"]'),
('flux-dev', 'FLUX Dev', 'High quality generation', 'text-to-image', 'FLUX', '1.0', 'starter', 1, 8, 24, '["512x512", "768x768", "1024x1024", "1536x1536"]'),
('flux-pro', 'FLUX Pro', 'Professional quality', 'text-to-image', 'FLUX', '1.0', 'pro', 2, 12, 32, '["512x512", "1024x1024", "2048x2048"]'),
('sd-xl-1.0', 'Stable Diffusion XL 1.0', 'SDXL base model', 'text-to-image', 'Stable Diffusion', 'XL-1.0', 'starter', 1, 5, 16, '["512x512", "1024x1024"]');
```

### 2. 모델 목록 조회 (Admin)

```python
# app/api/v1/admin/models.py
from fastapi import APIRouter, Depends, Query

router = APIRouter(prefix="/admin/models", tags=["Admin - Models"])


@router.get("/", response_model=List[AIModelDetail])
async def list_models(
    is_active: Optional[bool] = None,
    model_type: Optional[str] = None,
    required_plan: Optional[str] = None,
    current_admin: User = Depends(require_admin("models", "read")),
    db: AsyncSession = Depends(get_db)
):
    """AI 모델 목록 조회 (Admin)"""

    stmt = select(AIModel)

    conditions = []
    if is_active is not None:
        conditions.append(AIModel.is_active == is_active)
    if model_type:
        conditions.append(AIModel.model_type == model_type)
    if required_plan:
        conditions.append(AIModel.required_plan == required_plan)

    if conditions:
        stmt = stmt.where(*conditions)

    stmt = stmt.order_by(AIModel.min_plan_tier.asc(), AIModel.model_name.asc())

    result = await db.execute(stmt)
    models = result.scalars().all()

    # 각 모델의 최근 30일 통계 추가
    thirty_days_ago = datetime.utcnow() - timedelta(days=30)

    model_details = []
    for model in models:
        # 최근 30일 사용 통계
        stats_stmt = select(
            func.count(Job.job_id).label("recent_generations"),
            func.avg(Job.generation_time_sec).label("avg_time")
        ).where(
            Job.model_name == model.model_name,
            Job.created_at >= thirty_days_ago,
            Job.status == "completed"
        )
        stats_result = await db.execute(stats_stmt)
        stats = stats_result.one()

        model_details.append(AIModelDetail(
            **model.__dict__,
            recent_30d_generations=stats.recent_generations or 0,
            recent_30d_avg_time=float(stats.avg_time) if stats.avg_time else 0
        ))

    return model_details
```

### 3. 커스텀 모델 업로드

```python
class ModelUploadRequest(BaseModel):
    model_name: str
    display_name: str
    description: str
    model_type: str  # text-to-image, image-to-image
    base_model: str
    version: str
    required_plan: str = "pro"
    min_plan_tier: int = 2
    supported_sizes: List[str] = ["512x512", "1024x1024"]


@router.post("/upload", response_model=AIModelDetail)
async def upload_custom_model(
    file: UploadFile,
    request: ModelUploadRequest = Depends(),
    current_admin: User = Depends(require_admin("models", "write")),
    db: AsyncSession = Depends(get_db)
):
    """
    커스텀 AI 모델 업로드

    **지원 형식:**
    - SafeTensors (.safetensors)
    - PyTorch (.pt, .pth)
    - ONNX (.onnx)

    **최대 크기:** 25GB
    """

    # 1. 파일 검증
    allowed_extensions = [".safetensors", ".pt", ".pth", ".onnx"]
    file_ext = os.path.splitext(file.filename)[1].lower()

    if file_ext not in allowed_extensions:
        raise HTTPException(
            400,
            f"Unsupported file format. Allowed: {', '.join(allowed_extensions)}"
        )

    # 2. 모델명 중복 확인
    existing_stmt = select(AIModel).where(AIModel.model_name == request.model_name)
    existing_result = await db.execute(existing_stmt)
    if existing_result.scalar_one_or_none():
        raise HTTPException(400, f"Model '{request.model_name}' already exists")

    # 3. S3 업로드
    s3_client = S3Client()
    model_s3_key = f"models/{request.model_name}/{file.filename}"

    # 파일 크기 계산
    file.file.seek(0, 2)  # EOF로 이동
    file_size_bytes = file.file.tell()
    file.file.seek(0)  # 처음으로 되돌리기

    file_size_gb = file_size_bytes / (1024 ** 3)

    # 최대 크기 제한 (25GB)
    if file_size_gb > 25:
        raise HTTPException(400, f"Model file too large: {file_size_gb:.2f}GB (max 25GB)")

    # S3 multipart upload
    s3_client.upload_large_file(file.file, model_s3_key)

    # 4. 데이터베이스에 모델 정보 저장
    new_model = AIModel(
        model_name=request.model_name,
        display_name=request.display_name,
        description=request.description,
        model_type=request.model_type,
        base_model=request.base_model,
        version=request.version,
        s3_model_path=model_s3_key,
        model_size_gb=round(file_size_gb, 2),
        required_plan=request.required_plan,
        min_plan_tier=request.min_plan_tier,
        supported_sizes=request.supported_sizes,
        is_active=False,  # 기본적으로 비활성화 (검증 후 활성화)
        created_by=current_admin.user_id
    )

    db.add(new_model)

    # 5. 감사 로그
    audit_log = AdminAuditLog(
        admin_user_id=current_admin.user_id,
        action="upload_model",
        resource_type="model",
        resource_id=str(new_model.model_id),
        details={
            "model_name": request.model_name,
            "file_size_gb": round(file_size_gb, 2),
            "s3_key": model_s3_key
        }
    )
    db.add(audit_log)

    await db.commit()
    await db.refresh(new_model)

    return new_model
```

### 4. 모델 활성화/비활성화

```python
@router.patch("/{model_id}/status")
async def update_model_status(
    model_id: str,
    is_active: bool,
    current_admin: User = Depends(require_admin("models", "write")),
    db: AsyncSession = Depends(get_db)
):
    """모델 활성화/비활성화"""

    # 1. 모델 조회
    stmt = select(AIModel).where(AIModel.model_id == model_id)
    result = await db.execute(stmt)
    model = result.scalar_one_or_none()

    if not model:
        raise HTTPException(404, "Model not found")

    old_status = model.is_active

    # 2. 상태 변경
    model.is_active = is_active
    model.updated_at = datetime.utcnow()

    # 3. 비활성화 시 진행 중인 작업 취소
    if not is_active:
        pending_jobs_stmt = select(Job).where(
            Job.model_name == model.model_name,
            Job.status.in_(["pending", "processing"])
        )
        result = await db.execute(pending_jobs_stmt)
        pending_jobs = result.scalars().all()

        for job in pending_jobs:
            from app.worker import celery_app
            celery_app.control.revoke(str(job.job_id), terminate=True)

            job.status = "cancelled"
            job.error_message = f"Model '{model.model_name}' has been disabled by admin"

    # 4. 감사 로그
    audit_log = AdminAuditLog(
        admin_user_id=current_admin.user_id,
        action="update_model_status",
        resource_type="model",
        resource_id=model_id,
        details={
            "model_name": model.model_name,
            "old_status": "active" if old_status else "inactive",
            "new_status": "active" if is_active else "inactive"
        }
    )
    db.add(audit_log)

    await db.commit()

    return {
        "message": f"Model {'activated' if is_active else 'deactivated'} successfully",
        "model_id": model_id,
        "model_name": model.model_name,
        "is_active": is_active
    }
```

### 5. 모델 접근 권한 변경

```python
class ModelAccessUpdateRequest(BaseModel):
    required_plan: str  # free, starter, pro, studio, enterprise
    min_plan_tier: int  # 0-4


@router.patch("/{model_id}/access")
async def update_model_access(
    model_id: str,
    request: ModelAccessUpdateRequest,
    current_admin: User = Depends(require_admin("models", "write")),
    db: AsyncSession = Depends(get_db)
):
    """모델 접근 권한 변경"""

    # 1. 모델 조회
    stmt = select(AIModel).where(AIModel.model_id == model_id)
    result = await db.execute(stmt)
    model = result.scalar_one_or_none()

    if not model:
        raise HTTPException(404, "Model not found")

    old_plan = model.required_plan
    old_tier = model.min_plan_tier

    # 2. 접근 권한 업데이트
    model.required_plan = request.required_plan
    model.min_plan_tier = request.min_plan_tier
    model.updated_at = datetime.utcnow()

    # 3. 감사 로그
    audit_log = AdminAuditLog(
        admin_user_id=current_admin.user_id,
        action="update_model_access",
        resource_type="model",
        resource_id=model_id,
        details={
            "model_name": model.model_name,
            "old_required_plan": old_plan,
            "new_required_plan": request.required_plan,
            "old_tier": old_tier,
            "new_tier": request.min_plan_tier
        }
    )
    db.add(audit_log)

    await db.commit()

    return {
        "message": "Model access updated successfully",
        "model_id": model_id,
        "model_name": model.model_name,
        "required_plan": request.required_plan
    }
```

---

## 시스템 통계 대시보드

### 1. 전체 시스템 통계 API

```python
# app/api/v1/admin/statistics.py
from fastapi import APIRouter, Depends, Query
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_, case

router = APIRouter(prefix="/admin/statistics", tags=["Admin - Statistics"])


class SystemStatistics(BaseModel):
    """시스템 전체 통계"""

    # 사용자 통계
    total_users: int
    active_users_30d: int
    new_users_30d: int
    users_by_plan: Dict[str, int]

    # 매출 통계
    total_revenue_usd: float
    revenue_30d_usd: float
    revenue_by_plan: Dict[str, float]
    mrr: float  # Monthly Recurring Revenue

    # 크레딧 통계
    total_credits_issued: int
    total_credits_used: int
    credits_used_30d: int
    avg_credits_per_user: float

    # 이미지 생성 통계
    total_images: int
    images_30d: int
    avg_images_per_user: float

    # 스토리지 통계
    total_storage_gb: float
    avg_storage_per_user_mb: float

    # 모델 사용 통계
    popular_models: List[Dict[str, Any]]

    # 시스템 상태
    active_jobs: int
    pending_jobs: int
    failed_jobs_24h: int
    avg_generation_time_sec: float


@router.get("/overview", response_model=SystemStatistics)
async def get_system_statistics(
    current_admin: User = Depends(require_admin("system", "read")),
    db: AsyncSession = Depends(get_db)
):
    """시스템 전체 통계 조회"""

    now = datetime.utcnow()
    thirty_days_ago = now - timedelta(days=30)
    twenty_four_hours_ago = now - timedelta(hours=24)

    # 1. 사용자 통계
    total_users_stmt = select(func.count(User.user_id))
    total_users = (await db.execute(total_users_stmt)).scalar()

    # 활성 사용자 (30일 이내 이미지 생성)
    active_users_stmt = select(func.count(func.distinct(Image.user_id))).where(
        Image.created_at >= thirty_days_ago
    )
    active_users_30d = (await db.execute(active_users_stmt)).scalar()

    # 신규 사용자 (30일 이내 가입)
    new_users_stmt = select(func.count(User.user_id)).where(
        User.created_at >= thirty_days_ago
    )
    new_users_30d = (await db.execute(new_users_stmt)).scalar()

    # 플랜별 사용자 수
    users_by_plan_stmt = select(
        User.subscription_plan,
        func.count(User.user_id)
    ).group_by(User.subscription_plan)
    users_by_plan_result = await db.execute(users_by_plan_stmt)
    users_by_plan = {row[0]: row[1] for row in users_by_plan_result}

    # 2. 매출 통계
    total_revenue_stmt = select(
        func.sum(SubscriptionHistory.amount_paid)
    ).where(SubscriptionHistory.status == "active")
    total_revenue_usd = (await db.execute(total_revenue_stmt)).scalar() or 0
    total_revenue_usd = float(total_revenue_usd) / 100  # cents to dollars

    # 최근 30일 매출
    revenue_30d_stmt = select(
        func.sum(SubscriptionHistory.amount_paid)
    ).where(
        SubscriptionHistory.created_at >= thirty_days_ago,
        SubscriptionHistory.status == "active"
    )
    revenue_30d_usd = (await db.execute(revenue_30d_stmt)).scalar() or 0
    revenue_30d_usd = float(revenue_30d_usd) / 100

    # 플랜별 매출
    revenue_by_plan_stmt = select(
        User.subscription_plan,
        func.sum(SubscriptionHistory.amount_paid)
    ).join(
        User, User.user_id == SubscriptionHistory.user_id
    ).where(
        SubscriptionHistory.status == "active"
    ).group_by(User.subscription_plan)
    revenue_by_plan_result = await db.execute(revenue_by_plan_stmt)
    revenue_by_plan = {
        row[0]: float(row[1] or 0) / 100
        for row in revenue_by_plan_result
    }

    # MRR 계산 (월간 구독 매출)
    mrr_stmt = select(
        func.sum(
            case(
                (User.subscription_billing_cycle == "monthly", SubscriptionHistory.amount_paid),
                (User.subscription_billing_cycle == "yearly", SubscriptionHistory.amount_paid / 12),
                else_=0
            )
        )
    ).join(
        User, User.user_id == SubscriptionHistory.user_id
    ).where(
        User.subscription_status == "active"
    )
    mrr = (await db.execute(mrr_stmt)).scalar() or 0
    mrr = float(mrr) / 100

    # 3. 크레딧 통계
    total_credits_issued_stmt = select(
        func.sum(CreditTransaction.credits)
    ).where(CreditTransaction.transaction_type.in_(["purchase", "admin_credit"]))
    total_credits_issued = (await db.execute(total_credits_issued_stmt)).scalar() or 0

    total_credits_used_stmt = select(
        func.sum(CreditTransaction.credits)
    ).where(CreditTransaction.transaction_type == "usage")
    total_credits_used = (await db.execute(total_credits_used_stmt)).scalar() or 0

    credits_used_30d_stmt = select(
        func.sum(CreditTransaction.credits)
    ).where(
        CreditTransaction.transaction_type == "usage",
        CreditTransaction.created_at >= thirty_days_ago
    )
    credits_used_30d = (await db.execute(credits_used_30d_stmt)).scalar() or 0

    avg_credits_per_user = total_credits_used / total_users if total_users > 0 else 0

    # 4. 이미지 생성 통계
    total_images_stmt = select(func.count(Image.image_id))
    total_images = (await db.execute(total_images_stmt)).scalar()

    images_30d_stmt = select(func.count(Image.image_id)).where(
        Image.created_at >= thirty_days_ago
    )
    images_30d = (await db.execute(images_30d_stmt)).scalar()

    avg_images_per_user = total_images / total_users if total_users > 0 else 0

    # 5. 스토리지 통계
    total_storage_stmt = select(func.sum(StorageUsage.total_size_mb))
    total_storage_mb = (await db.execute(total_storage_stmt)).scalar() or 0
    total_storage_gb = float(total_storage_mb) / 1024

    avg_storage_per_user_mb = total_storage_mb / total_users if total_users > 0 else 0

    # 6. 인기 모델 Top 10 (30일 기준)
    popular_models_stmt = select(
        Job.model_name,
        func.count(Job.job_id).label("total_generations"),
        func.avg(Job.generation_time_sec).label("avg_time"),
        func.sum(Job.credits_used).label("total_credits")
    ).where(
        Job.created_at >= thirty_days_ago,
        Job.status == "completed"
    ).group_by(Job.model_name).order_by(func.count(Job.job_id).desc()).limit(10)

    popular_models_result = await db.execute(popular_models_stmt)
    popular_models = [
        {
            "model_name": row[0],
            "total_generations": row[1],
            "avg_generation_time_sec": float(row[2]) if row[2] else 0,
            "total_credits_used": row[3] or 0
        }
        for row in popular_models_result
    ]

    # 7. 시스템 상태
    active_jobs_stmt = select(func.count(Job.job_id)).where(
        Job.status == "processing"
    )
    active_jobs = (await db.execute(active_jobs_stmt)).scalar()

    pending_jobs_stmt = select(func.count(Job.job_id)).where(
        Job.status == "pending"
    )
    pending_jobs = (await db.execute(pending_jobs_stmt)).scalar()

    failed_jobs_stmt = select(func.count(Job.job_id)).where(
        Job.status == "failed",
        Job.created_at >= twenty_four_hours_ago
    )
    failed_jobs_24h = (await db.execute(failed_jobs_stmt)).scalar()

    avg_gen_time_stmt = select(
        func.avg(Job.generation_time_sec)
    ).where(
        Job.status == "completed",
        Job.created_at >= thirty_days_ago
    )
    avg_generation_time_sec = (await db.execute(avg_gen_time_stmt)).scalar() or 0

    return SystemStatistics(
        total_users=total_users,
        active_users_30d=active_users_30d,
        new_users_30d=new_users_30d,
        users_by_plan=users_by_plan,
        total_revenue_usd=round(total_revenue_usd, 2),
        revenue_30d_usd=round(revenue_30d_usd, 2),
        revenue_by_plan={k: round(v, 2) for k, v in revenue_by_plan.items()},
        mrr=round(mrr, 2),
        total_credits_issued=total_credits_issued,
        total_credits_used=total_credits_used,
        credits_used_30d=credits_used_30d,
        avg_credits_per_user=round(avg_credits_per_user, 2),
        total_images=total_images,
        images_30d=images_30d,
        avg_images_per_user=round(avg_images_per_user, 2),
        total_storage_gb=round(total_storage_gb, 2),
        avg_storage_per_user_mb=round(avg_storage_per_user_mb, 2),
        popular_models=popular_models,
        active_jobs=active_jobs,
        pending_jobs=pending_jobs,
        failed_jobs_24h=failed_jobs_24h,
        avg_generation_time_sec=round(float(avg_generation_time_sec), 2)
    )
```

### 2. 시계열 통계 (차트용)

```python
@router.get("/timeseries")
async def get_timeseries_statistics(
    metric: str = Query(..., description="users|revenue|credits|images"),
    period: str = Query("30d", description="7d|30d|90d|1y"),
    current_admin: User = Depends(require_admin("system", "read")),
    db: AsyncSession = Depends(get_db)
):
    """
    시계열 통계 데이터 (차트용)

    **지원 메트릭:**
    - users: 신규 사용자 수
    - revenue: 일일 매출
    - credits: 크레딧 사용량
    - images: 이미지 생성 수
    """

    # 기간 계산
    period_days = {
        "7d": 7,
        "30d": 30,
        "90d": 90,
        "1y": 365
    }

    days = period_days.get(period, 30)
    start_date = datetime.utcnow() - timedelta(days=days)

    if metric == "users":
        # 일별 신규 사용자 수
        stmt = select(
            func.date(User.created_at).label("date"),
            func.count(User.user_id).label("count")
        ).where(
            User.created_at >= start_date
        ).group_by(func.date(User.created_at)).order_by(func.date(User.created_at))

    elif metric == "revenue":
        # 일별 매출
        stmt = select(
            func.date(SubscriptionHistory.created_at).label("date"),
            func.sum(SubscriptionHistory.amount_paid).label("count")
        ).where(
            SubscriptionHistory.created_at >= start_date,
            SubscriptionHistory.status == "active"
        ).group_by(func.date(SubscriptionHistory.created_at)).order_by(func.date(SubscriptionHistory.created_at))

    elif metric == "credits":
        # 일별 크레딧 사용량
        stmt = select(
            func.date(CreditTransaction.created_at).label("date"),
            func.sum(CreditTransaction.credits).label("count")
        ).where(
            CreditTransaction.created_at >= start_date,
            CreditTransaction.transaction_type == "usage"
        ).group_by(func.date(CreditTransaction.created_at)).order_by(func.date(CreditTransaction.created_at))

    elif metric == "images":
        # 일별 이미지 생성 수
        stmt = select(
            func.date(Image.created_at).label("date"),
            func.count(Image.image_id).label("count")
        ).where(
            Image.created_at >= start_date
        ).group_by(func.date(Image.created_at)).order_by(func.date(Image.created_at))

    else:
        raise HTTPException(400, f"Invalid metric: {metric}")

    result = await db.execute(stmt)
    data = result.all()

    # 결과 포맷팅
    timeseries = [
        {
            "date": str(row.date),
            "value": float(row.count) / 100 if metric == "revenue" else row.count
        }
        for row in data
    ]

    return {
        "metric": metric,
        "period": period,
        "data": timeseries
    }
```

---

## 관리자 감사 로그

### 1. Database Schema

```sql
-- 관리자 감사 로그 테이블
CREATE TABLE admin_audit_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES users(user_id),
    action VARCHAR(100) NOT NULL,  -- change_subscription, adjust_credits, upload_model, etc.
    resource_type VARCHAR(50),  -- user, model, credit, system
    resource_id VARCHAR(255),
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_admin_audit_logs_admin ON admin_audit_logs(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_logs_action ON admin_audit_logs(action, created_at DESC);
CREATE INDEX idx_admin_audit_logs_resource ON admin_audit_logs(resource_type, resource_id);
```

### 2. 감사 로그 조회 API

```python
@router.get("/audit-logs", response_model=PaginatedResponse[AdminAuditLog])
async def get_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    admin_user_id: Optional[str] = None,
    action: Optional[str] = None,
    resource_type: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    current_admin: User = Depends(require_admin("system", "read")),
    db: AsyncSession = Depends(get_db)
):
    """감사 로그 조회 (Admin)"""

    stmt = select(AdminAuditLog).options(
        selectinload(AdminAuditLog.admin_user)
    )

    conditions = []

    if admin_user_id:
        conditions.append(AdminAuditLog.admin_user_id == admin_user_id)

    if action:
        conditions.append(AdminAuditLog.action == action)

    if resource_type:
        conditions.append(AdminAuditLog.resource_type == resource_type)

    if start_date:
        conditions.append(AdminAuditLog.created_at >= start_date)

    if end_date:
        conditions.append(AdminAuditLog.created_at <= end_date)

    if conditions:
        stmt = stmt.where(*conditions)

    stmt = stmt.order_by(AdminAuditLog.created_at.desc())

    # 총 개수
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar()

    # 페이지네이션
    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size)

    result = await db.execute(stmt)
    logs = result.scalars().all()

    return PaginatedResponse(
        items=logs,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size
    )
```

---

## Admin Frontend UI

### 1. Admin Dashboard 메인 페이지

```tsx
// frontend/src/pages/admin/Dashboard.tsx
import React, { useEffect, useState } from 'react';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import axios from 'axios';

interface SystemStatistics {
  total_users: number;
  active_users_30d: number;
  new_users_30d: number;
  users_by_plan: Record<string, number>;
  total_revenue_usd: number;
  revenue_30d_usd: number;
  mrr: number;
  total_credits_used: number;
  credits_used_30d: number;
  total_images: number;
  images_30d: number;
  popular_models: Array<{
    model_name: string;
    total_generations: number;
    avg_generation_time_sec: number;
  }>;
  active_jobs: number;
  pending_jobs: number;
  failed_jobs_24h: number;
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8'];

export const AdminDashboard: React.FC = () => {
  const [stats, setStats] = useState<SystemStatistics | null>(null);
  const [timeseriesData, setTimeseriesData] = useState<any[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<'users' | 'revenue' | 'credits' | 'images'>('users');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStatistics();
    loadTimeseries(selectedMetric);
  }, []);

  useEffect(() => {
    loadTimeseries(selectedMetric);
  }, [selectedMetric]);

  const loadStatistics = async () => {
    try {
      const response = await axios.get('/api/v1/admin/statistics/overview', {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('admin_token')}`,
        },
      });
      setStats(response.data);
    } catch (error) {
      console.error('Failed to load statistics:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadTimeseries = async (metric: string) => {
    try {
      const response = await axios.get('/api/v1/admin/statistics/timeseries', {
        params: { metric, period: '30d' },
        headers: {
          Authorization: `Bearer ${localStorage.getItem('admin_token')}`,
        },
      });
      setTimeseriesData(response.data.data);
    } catch (error) {
      console.error('Failed to load timeseries:', error);
    }
  };

  if (loading || !stats) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
  }

  // 플랜별 사용자 수 차트 데이터
  const planChartData = Object.entries(stats.users_by_plan).map(([plan, count]) => ({
    name: plan,
    value: count,
  }));

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-gray-500 text-sm font-medium">Total Users</h3>
          <p className="text-3xl font-bold mt-2">{stats.total_users.toLocaleString()}</p>
          <p className="text-green-600 text-sm mt-1">+{stats.new_users_30d} this month</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-gray-500 text-sm font-medium">Revenue (30d)</h3>
          <p className="text-3xl font-bold mt-2">${stats.revenue_30d_usd.toLocaleString()}</p>
          <p className="text-gray-600 text-sm mt-1">MRR: ${stats.mrr.toLocaleString()}</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-gray-500 text-sm font-medium">Credits Used (30d)</h3>
          <p className="text-3xl font-bold mt-2">{stats.credits_used_30d.toLocaleString()}</p>
          <p className="text-gray-600 text-sm mt-1">Total: {stats.total_credits_used.toLocaleString()}</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-gray-500 text-sm font-medium">Images (30d)</h3>
          <p className="text-3xl font-bold mt-2">{stats.images_30d.toLocaleString()}</p>
          <p className="text-gray-600 text-sm mt-1">Total: {stats.total_images.toLocaleString()}</p>
        </div>
      </div>

      {/* System Status */}
      <div className="bg-white p-6 rounded-lg shadow mb-8">
        <h2 className="text-xl font-bold mb-4">System Status</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-gray-500 text-sm">Active Jobs</p>
            <p className="text-2xl font-bold text-green-600">{stats.active_jobs}</p>
          </div>
          <div>
            <p className="text-gray-500 text-sm">Pending Jobs</p>
            <p className="text-2xl font-bold text-yellow-600">{stats.pending_jobs}</p>
          </div>
          <div>
            <p className="text-gray-500 text-sm">Failed Jobs (24h)</p>
            <p className="text-2xl font-bold text-red-600">{stats.failed_jobs_24h}</p>
          </div>
        </div>
      </div>

      {/* Timeseries Chart */}
      <div className="bg-white p-6 rounded-lg shadow mb-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">Trends (Last 30 Days)</h2>
          <div className="flex gap-2">
            {['users', 'revenue', 'credits', 'images'].map((metric) => (
              <button
                key={metric}
                onClick={() => setSelectedMetric(metric as any)}
                className={`px-4 py-2 rounded ${
                  selectedMetric === metric
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {metric.charAt(0).toUpperCase() + metric.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={timeseriesData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="value" stroke="#8884d8" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Users by Plan (Pie Chart) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">Users by Plan</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={planChartData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {planChartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Popular Models */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">Popular Models (30d)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={stats.popular_models.slice(0, 5)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="model_name" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="total_generations" fill="#8884d8" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};
```

### 2. 사용자 관리 페이지

```tsx
// frontend/src/pages/admin/UserManagement.tsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Table, Button, Modal, Form, Input, Select, DatePicker, Tag, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';

interface User {
  user_id: string;
  email: string;
  username: string;
  subscription_plan: string;
  subscription_status: string;
  credits_balance: number;
  is_active: boolean;
  created_at: string;
}

export const UserManagement: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 50, total: 0 });
  const [filters, setFilters] = useState<any>({});

  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalType, setModalType] = useState<'subscription' | 'credits' | 'status' | null>(null);

  useEffect(() => {
    loadUsers();
  }, [pagination.current, filters]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/v1/admin/users/', {
        params: {
          page: pagination.current,
          page_size: pagination.pageSize,
          ...filters,
        },
        headers: {
          Authorization: `Bearer ${localStorage.getItem('admin_token')}`,
        },
      });

      setUsers(response.data.items);
      setPagination({
        ...pagination,
        total: response.data.total,
      });
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleChangePlan = async (values: any) => {
    try {
      await axios.post(
        `/api/v1/admin/users/${selectedUser?.user_id}/change-subscription`,
        {
          new_plan: values.new_plan,
          reason: values.reason,
          notify_user: values.notify_user,
        },
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('admin_token')}`,
          },
        }
      );

      setModalVisible(false);
      loadUsers();
    } catch (error) {
      console.error('Failed to change plan:', error);
    }
  };

  const handleAdjustCredits = async (values: any) => {
    try {
      await axios.post(
        `/api/v1/admin/users/${selectedUser?.user_id}/adjust-credits`,
        {
          credits: parseInt(values.credits),
          reason: values.reason,
          notify_user: values.notify_user,
        },
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('admin_token')}`,
          },
        }
      );

      setModalVisible(false);
      loadUsers();
    } catch (error) {
      console.error('Failed to adjust credits:', error);
    }
  };

  const handleUpdateStatus = async (values: any) => {
    try {
      await axios.post(
        `/api/v1/admin/users/${selectedUser?.user_id}/status`,
        {
          is_active: values.is_active,
          reason: values.reason,
          notify_user: values.notify_user,
        },
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('admin_token')}`,
          },
        }
      );

      setModalVisible(false);
      loadUsers();
    } catch (error) {
      console.error('Failed to update status:', error);
    }
  };

  const columns: ColumnsType<User> = [
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      width: 250,
    },
    {
      title: 'Plan',
      dataIndex: 'subscription_plan',
      key: 'subscription_plan',
      render: (plan: string) => (
        <Tag color={
          plan === 'enterprise' ? 'purple' :
          plan === 'studio' ? 'blue' :
          plan === 'pro' ? 'green' :
          plan === 'starter' ? 'orange' : 'default'
        }>
          {plan.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'subscription_status',
      key: 'subscription_status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'green' : 'red'}>
          {status.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Credits',
      dataIndex: 'credits_balance',
      key: 'credits_balance',
      render: (credits: number) => credits.toLocaleString(),
    },
    {
      title: 'Active',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'green' : 'red'}>
          {isActive ? 'ACTIVE' : 'SUSPENDED'}
        </Tag>
      ),
    },
    {
      title: 'Registered',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            size="small"
            onClick={() => {
              setSelectedUser(record);
              setModalType('subscription');
              setModalVisible(true);
            }}
          >
            Change Plan
          </Button>
          <Button
            size="small"
            onClick={() => {
              setSelectedUser(record);
              setModalType('credits');
              setModalVisible(true);
            }}
          >
            Adjust Credits
          </Button>
          <Button
            size="small"
            danger={record.is_active}
            onClick={() => {
              setSelectedUser(record);
              setModalType('status');
              setModalVisible(true);
            }}
          >
            {record.is_active ? 'Suspend' : 'Activate'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">User Management</h1>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow mb-6">
        <Form layout="inline" onFinish={(values) => setFilters(values)}>
          <Form.Item name="search">
            <Input placeholder="Search email/username" />
          </Form.Item>
          <Form.Item name="subscription_plan">
            <Select placeholder="Plan" style={{ width: 150 }} allowClear>
              <Select.Option value="free">Free</Select.Option>
              <Select.Option value="starter">Starter</Select.Option>
              <Select.Option value="pro">Pro</Select.Option>
              <Select.Option value="studio">Studio</Select.Option>
              <Select.Option value="enterprise">Enterprise</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="is_active">
            <Select placeholder="Status" style={{ width: 150 }} allowClear>
              <Select.Option value={true}>Active</Select.Option>
              <Select.Option value={false}>Suspended</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              Filter
            </Button>
          </Form.Item>
        </Form>
      </div>

      {/* User Table */}
      <Table
        columns={columns}
        dataSource={users}
        rowKey="user_id"
        loading={loading}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: pagination.total,
          onChange: (page) => setPagination({ ...pagination, current: page }),
        }}
      />

      {/* Modals */}
      <Modal
        title={
          modalType === 'subscription' ? 'Change Subscription Plan' :
          modalType === 'credits' ? 'Adjust Credits' :
          'Update Account Status'
        }
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
      >
        {modalType === 'subscription' && (
          <Form onFinish={handleChangePlan} layout="vertical">
            <Form.Item name="new_plan" label="New Plan" rules={[{ required: true }]}>
              <Select>
                <Select.Option value="free">Free</Select.Option>
                <Select.Option value="starter">Starter</Select.Option>
                <Select.Option value="pro">Pro</Select.Option>
                <Select.Option value="studio">Studio</Select.Option>
                <Select.Option value="enterprise">Enterprise</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="reason" label="Reason" rules={[{ required: true }]}>
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item name="notify_user" valuePropName="checked" initialValue={true}>
              <input type="checkbox" /> Notify user by email
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block>
                Change Plan
              </Button>
            </Form.Item>
          </Form>
        )}

        {modalType === 'credits' && (
          <Form onFinish={handleAdjustCredits} layout="vertical">
            <Form.Item name="credits" label="Credits (+ to add, - to subtract)" rules={[{ required: true }]}>
              <Input type="number" placeholder="e.g., 1000 or -500" />
            </Form.Item>
            <Form.Item name="reason" label="Reason" rules={[{ required: true }]}>
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item name="notify_user" valuePropName="checked" initialValue={true}>
              <input type="checkbox" /> Notify user by email
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block>
                Adjust Credits
              </Button>
            </Form.Item>
          </Form>
        )}

        {modalType === 'status' && (
          <Form onFinish={handleUpdateStatus} layout="vertical">
            <Form.Item name="is_active" label="Status" rules={[{ required: true }]}>
              <Select>
                <Select.Option value={true}>Activate</Select.Option>
                <Select.Option value={false}>Suspend</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="reason" label="Reason" rules={[{ required: true }]}>
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item name="notify_user" valuePropName="checked" initialValue={true}>
              <input type="checkbox" /> Notify user by email
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block>
                Update Status
              </Button>
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
};
```

---

## 보안 고려사항

### 1. 보안 체크리스트

```yaml
Admin Security Checklist:

1. 인증 및 권한:
   - ✓ JWT 토큰 기반 인증
   - ✓ Role-based access control (superadmin, admin, support)
   - ✓ 2FA (TOTP) 필수 활성화
   - ✓ IP 화이트리스트

2. 감사 및 모니터링:
   - ✓ 모든 관리자 작업 로깅
   - ✓ 실시간 알림 (중요 작업)
   - ✓ 비정상 접근 감지

3. 데이터 보호:
   - ✓ 민감 정보 마스킹 (로그)
   - ✓ HTTPS only
   - ✓ CORS 제한
   - ✓ Rate limiting

4. 운영:
   - ✓ 정기 권한 검토
   - ✓ Admin 계정 정기 rotation
   - ✓ 비활성 계정 자동 비활성화
```

### 2. Rate Limiting

```python
# app/middleware/rate_limit.py
from fastapi import Request, HTTPException
from redis import Redis
import time

redis_client = Redis(host='localhost', port=6379, db=0)

def admin_rate_limit(max_requests: int = 100, window_seconds: int = 60):
    """Admin API rate limiting"""

    async def rate_limit_middleware(request: Request):
        # Admin 사용자 ID 추출
        user_id = request.state.user.user_id

        # Redis key
        key = f"admin_rate_limit:{user_id}"

        # 현재 요청 수 확인
        current_requests = redis_client.get(key)

        if current_requests and int(current_requests) >= max_requests:
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded: {max_requests} requests per {window_seconds} seconds"
            )

        # 요청 수 증가
        pipe = redis_client.pipeline()
        pipe.incr(key)
        pipe.expire(key, window_seconds)
        pipe.execute()

    return rate_limit_middleware
```

---

## 테스트

### 1. Admin API 테스트

```python
# tests/test_admin_users.py
import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

@pytest.fixture
def admin_token():
    """Admin 토큰 생성"""
    response = client.post("/api/v1/auth/login", json={
        "email": "admin@pingvasai.com",
        "password": "admin123"
    })
    return response.json()["access_token"]


def test_list_users(admin_token):
    """사용자 목록 조회 테스트"""
    response = client.get(
        "/api/v1/admin/users/",
        headers={"Authorization": f"Bearer {admin_token}"}
    )

    assert response.status_code == 200
    data = response.json()
    assert "items" in data
    assert "total" in data
    assert isinstance(data["items"], list)


def test_change_subscription(admin_token, test_user):
    """구독 플랜 변경 테스트"""
    response = client.post(
        f"/api/v1/admin/users/{test_user.user_id}/change-subscription",
        json={
            "new_plan": "pro",
            "reason": "Customer support request",
            "notify_user": False
        },
        headers={"Authorization": f"Bearer {admin_token}"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["new_plan"] == "pro"
    assert data["credits_added"] == 7500  # Pro plan monthly credits


def test_adjust_credits(admin_token, test_user):
    """크레딧 조정 테스트"""
    # 크레딧 추가
    response = client.post(
        f"/api/v1/admin/users/{test_user.user_id}/adjust-credits",
        json={
            "credits": 1000,
            "reason": "Compensation for service issue",
            "notify_user": False
        },
        headers={"Authorization": f"Bearer {admin_token}"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["adjustment"] == 1000

    # 크레딧 차감
    response = client.post(
        f"/api/v1/admin/users/{test_user.user_id}/adjust-credits",
        json={
            "credits": -500,
            "reason": "Refund adjustment",
            "notify_user": False
        },
        headers={"Authorization": f"Bearer {admin_token}"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["adjustment"] == -500


def test_suspend_user(admin_token, test_user):
    """사용자 정지 테스트"""
    response = client.post(
        f"/api/v1/admin/users/{test_user.user_id}/status",
        json={
            "is_active": False,
            "reason": "Terms of service violation",
            "notify_user": True
        },
        headers={"Authorization": f"Bearer {admin_token}"}
    )

    assert response.status_code == 200
    assert response.json()["is_active"] == False


def test_unauthorized_access():
    """권한 없는 접근 테스트"""
    # 일반 사용자 토큰으로 admin API 접근
    user_response = client.post("/api/v1/auth/login", json={
        "email": "user@example.com",
        "password": "user123"
    })
    user_token = user_response.json()["access_token"]

    response = client.get(
        "/api/v1/admin/users/",
        headers={"Authorization": f"Bearer {user_token}"}
    )

    assert response.status_code == 403
    assert "Admin access required" in response.json()["detail"]
```

### 2. 통계 API 테스트

```python
# tests/test_admin_statistics.py
def test_system_statistics(admin_token):
    """시스템 통계 조회 테스트"""
    response = client.get(
        "/api/v1/admin/statistics/overview",
        headers={"Authorization": f"Bearer {admin_token}"}
    )

    assert response.status_code == 200
    data = response.json()

    # 필수 필드 확인
    assert "total_users" in data
    assert "total_revenue_usd" in data
    assert "total_credits_used" in data
    assert "popular_models" in data
    assert isinstance(data["popular_models"], list)


def test_timeseries_statistics(admin_token):
    """시계열 통계 조회 테스트"""
    for metric in ["users", "revenue", "credits", "images"]:
        response = client.get(
            "/api/v1/admin/statistics/timeseries",
            params={"metric": metric, "period": "30d"},
            headers={"Authorization": f"Bearer {admin_token}"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["metric"] == metric
        assert "data" in data
        assert isinstance(data["data"], list)
```

---

## Phase 7 완료

### 구현 완료 항목

✅ **Admin 인증 및 권한 관리**
- Role-based access control
- 2FA (TOTP)
- IP 화이트리스트
- JWT + 권한 미들웨어

✅ **사용자 관리 API**
- 사용자 목록 조회 (필터링, 페이지네이션)
- 구독 플랜 수동 변경
- 크레딧 수동 조정
- 계정 정지/활성화
- GDPR 준수 계정 삭제

✅ **모델 관리 시스템**
- 모델 목록 조회
- 커스텀 모델 업로드 (S3)
- 모델 활성화/비활성화
- 모델 접근 권한 관리

✅ **시스템 통계 대시보드**
- 전체 시스템 통계 (사용자, 매출, 크레딧, 이미지)
- 시계열 데이터 (차트용)
- 인기 모델 통계

✅ **관리자 감사 로그**
- 모든 admin 작업 로깅
- 감사 로그 조회 API

✅ **Admin Frontend UI**
- React 대시보드
- 사용자 관리 페이지
- 통계 차트 (Recharts)

✅ **보안 고려사항**
- Rate limiting
- 보안 체크리스트

✅ **테스트 코드**
- Admin API 테스트
- 통계 API 테스트

---

**다음 단계: Phase 8 - System Mailing**
