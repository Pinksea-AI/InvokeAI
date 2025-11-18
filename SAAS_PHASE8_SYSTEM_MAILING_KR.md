# Phase 8: System Mailing 구축 가이드

## 목차
1. [개요](#개요)
2. [이메일 서비스 선택 및 설정](#이메일-서비스-선택-및-설정)
3. [이메일 템플릿 시스템](#이메일-템플릿-시스템)
4. [트랜잭션 이메일](#트랜잭션-이메일)
5. [마케팅 이메일 (뉴스레터)](#마케팅-이메일-뉴스레터)
6. [이메일 로그 및 추적](#이메일-로그-및-추적)
7. [이메일 검증 및 보안](#이메일-검증-및-보안)
8. [테스트](#테스트)

---

## 개요

Phase 8에서는 시스템의 모든 이메일 발송 기능을 구축합니다.

### 주요 기능
- **트랜잭션 이메일**: 회원가입, 비밀번호 재설정, 구독 변경, 결제 알림
- **시스템 알림**: 크레딧 부족, 스토리지 용량 초과, 작업 완료
- **마케팅 이메일**: 뉴스레터, 프로모션, 제품 업데이트
- **Admin 알림**: 시스템 오류, 중요 이벤트
- **이메일 검증**: 회원가입 시 이메일 인증
- **추적 및 분석**: 열람률, 클릭률, 수신거부

### 기술 스택
- **이메일 서비스**: Amazon SES (비용 효율) + SendGrid (백업)
- **템플릿 엔진**: Jinja2
- **HTML/CSS 프레임워크**: MJML (반응형 이메일)
- **큐 시스템**: Celery + Redis
- **추적**: Amazon SES Event Publishing + SNS

---

## 이메일 서비스 선택 및 설정

### 1. Amazon SES 설정

```bash
# AWS CLI 설치 및 설정
aws configure

# SES 리전: us-east-1 (또는 원하는 리전)
# SES 발신 이메일 인증
aws ses verify-email-identity --email-address noreply@pingvasai.com
aws ses verify-email-identity --email-address support@pingvasai.com
aws ses verify-email-identity --email-address newsletter@pingvasai.com

# 도메인 인증 (권장)
aws ses verify-domain-identity --domain pingvasai.com

# DKIM 설정 (스팸 방지)
aws ses set-identity-dkim-enabled --identity pingvasai.com --dkim-enabled

# Production 환경 승인 요청 (Sandbox 해제)
# AWS Console에서 수동 요청 필요
```

#### DNS 레코드 설정

```dns
# SPF 레코드
pingvasai.com. IN TXT "v=spf1 include:amazonses.com ~all"

# DKIM 레코드 (AWS SES에서 제공)
abc123._domainkey.pingvasai.com. IN CNAME abc123.dkim.amazonses.com.
def456._domainkey.pingvasai.com. IN CNAME def456.dkim.amazonses.com.
ghi789._domainkey.pingvasai.com. IN CNAME ghi789.dkim.amazonses.com.

# DMARC 레코드 (스팸 방지)
_dmarc.pingvasai.com. IN TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@pingvasai.com"

# MX 레코드 (수신용, 선택)
pingvasai.com. IN MX 10 inbound-smtp.us-east-1.amazonaws.com.
```

### 2. Python SES 클라이언트

```python
# app/services/email_service.py
import boto3
from botocore.exceptions import ClientError
from typing import List, Optional, Dict, Any
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
import logging

logger = logging.getLogger(__name__)


class SESEmailService:
    """Amazon SES 이메일 발송 서비스"""

    def __init__(self):
        self.ses_client = boto3.client(
            'ses',
            region_name='us-east-1',
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY
        )
        self.sender_email = "noreply@pingvasai.com"
        self.sender_name = "PingvasAI"

    def send_email(
        self,
        to_addresses: List[str],
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
        cc_addresses: Optional[List[str]] = None,
        bcc_addresses: Optional[List[str]] = None,
        reply_to_addresses: Optional[List[str]] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
        configuration_set: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """
        이메일 발송

        Args:
            to_addresses: 수신자 이메일 리스트
            subject: 제목
            html_body: HTML 본문
            text_body: 텍스트 본문 (대체용)
            cc_addresses: 참조
            bcc_addresses: 숨은 참조
            reply_to_addresses: 답장 주소
            attachments: 첨부파일 [{filename, content, content_type}]
            configuration_set: SES Configuration Set (추적용)
            tags: 이메일 태그 (분류용)

        Returns:
            발송 결과 (message_id 포함)
        """

        try:
            # MIME 메시지 생성
            msg = MIMEMultipart('alternative')
            msg['Subject'] = subject
            msg['From'] = f"{self.sender_name} <{self.sender_email}>"
            msg['To'] = ", ".join(to_addresses)

            if cc_addresses:
                msg['Cc'] = ", ".join(cc_addresses)

            if reply_to_addresses:
                msg['Reply-To'] = ", ".join(reply_to_addresses)

            # 텍스트 파트
            if text_body:
                part_text = MIMEText(text_body, 'plain', 'utf-8')
                msg.attach(part_text)

            # HTML 파트
            part_html = MIMEText(html_body, 'html', 'utf-8')
            msg.attach(part_html)

            # 첨부파일
            if attachments:
                for attachment in attachments:
                    part = MIMEImage(
                        attachment['content'],
                        _subtype=attachment.get('subtype', 'png')
                    )
                    part.add_header(
                        'Content-Disposition',
                        f'attachment; filename={attachment["filename"]}'
                    )
                    msg.attach(part)

            # 발송 파라미터
            send_params = {
                'Source': msg['From'],
                'Destinations': {
                    'ToAddresses': to_addresses,
                },
                'RawMessage': {
                    'Data': msg.as_string()
                }
            }

            if cc_addresses:
                send_params['Destinations']['CcAddresses'] = cc_addresses

            if bcc_addresses:
                send_params['Destinations']['BccAddresses'] = bcc_addresses

            if configuration_set:
                send_params['ConfigurationSetName'] = configuration_set

            if tags:
                send_params['Tags'] = [
                    {'Name': k, 'Value': v} for k, v in tags.items()
                ]

            # 발송
            response = self.ses_client.send_raw_email(**send_params)

            logger.info(
                f"Email sent successfully to {to_addresses}. MessageId: {response['MessageId']}"
            )

            return {
                'success': True,
                'message_id': response['MessageId'],
                'request_id': response['ResponseMetadata']['RequestId']
            }

        except ClientError as e:
            error_code = e.response['Error']['Code']
            error_message = e.response['Error']['Message']

            logger.error(f"Failed to send email: {error_code} - {error_message}")

            return {
                'success': False,
                'error_code': error_code,
                'error_message': error_message
            }

    def send_templated_email(
        self,
        to_addresses: List[str],
        template_name: str,
        template_data: Dict[str, Any],
        configuration_set: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        SES 템플릿 이메일 발송

        Args:
            to_addresses: 수신자
            template_name: SES에 등록된 템플릿 이름
            template_data: 템플릿 변수 데이터
            configuration_set: Configuration Set
        """

        try:
            response = self.ses_client.send_templated_email(
                Source=f"{self.sender_name} <{self.sender_email}>",
                Destination={
                    'ToAddresses': to_addresses
                },
                Template=template_name,
                TemplateData=json.dumps(template_data),
                ConfigurationSetName=configuration_set
            )

            return {
                'success': True,
                'message_id': response['MessageId']
            }

        except ClientError as e:
            logger.error(f"Failed to send templated email: {e}")
            return {
                'success': False,
                'error': str(e)
            }

    def verify_email_address(self, email: str) -> bool:
        """이메일 주소 검증 상태 확인"""
        try:
            response = self.ses_client.get_identity_verification_attributes(
                Identities=[email]
            )
            attributes = response.get('VerificationAttributes', {})
            status = attributes.get(email, {}).get('VerificationStatus')
            return status == 'Success'
        except ClientError:
            return False

    def get_send_quota(self) -> Dict[str, float]:
        """SES 발송 할당량 조회"""
        try:
            response = self.ses_client.get_send_quota()
            return {
                'max_24_hour_send': response['Max24HourSend'],
                'max_send_rate': response['MaxSendRate'],
                'sent_last_24_hours': response['SentLast24Hours']
            }
        except ClientError as e:
            logger.error(f"Failed to get send quota: {e}")
            return {}

    def get_send_statistics(self) -> List[Dict[str, Any]]:
        """SES 발송 통계 조회"""
        try:
            response = self.ses_client.get_send_statistics()
            return response.get('SendDataPoints', [])
        except ClientError as e:
            logger.error(f"Failed to get send statistics: {e}")
            return []
```

### 3. SendGrid 백업 설정

```python
# app/services/sendgrid_service.py
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail, Email, To, Content
from typing import List, Dict, Any


class SendGridEmailService:
    """SendGrid 이메일 발송 서비스 (백업)"""

    def __init__(self):
        self.sg = SendGridAPIClient(api_key=settings.SENDGRID_API_KEY)
        self.sender_email = "noreply@pingvasai.com"
        self.sender_name = "PingvasAI"

    def send_email(
        self,
        to_addresses: List[str],
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
        template_id: Optional[str] = None,
        dynamic_template_data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """SendGrid 이메일 발송"""

        try:
            message = Mail(
                from_email=Email(self.sender_email, self.sender_name),
                to_emails=[To(email) for email in to_addresses],
                subject=subject,
                html_content=Content("text/html", html_body)
            )

            if text_body:
                message.add_content(Content("text/plain", text_body))

            if template_id:
                message.template_id = template_id

            if dynamic_template_data:
                message.dynamic_template_data = dynamic_template_data

            response = self.sg.send(message)

            return {
                'success': True,
                'status_code': response.status_code,
                'headers': dict(response.headers)
            }

        except Exception as e:
            logger.error(f"SendGrid send failed: {e}")
            return {
                'success': False,
                'error': str(e)
            }
```

### 4. 통합 이메일 서비스 (Fallback)

```python
# app/services/unified_email_service.py
class UnifiedEmailService:
    """통합 이메일 서비스 (Primary: SES, Fallback: SendGrid)"""

    def __init__(self):
        self.ses_service = SESEmailService()
        self.sendgrid_service = SendGridEmailService()
        self.primary_provider = "ses"  # or "sendgrid"

    async def send_email(
        self,
        to_addresses: List[str],
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        이메일 발송 (자동 Fallback)

        Primary 실패 시 자동으로 백업 서비스로 전환
        """

        # Primary 시도
        if self.primary_provider == "ses":
            result = self.ses_service.send_email(
                to_addresses, subject, html_body, text_body, **kwargs
            )

            if result['success']:
                return result

            # SES 실패 시 SendGrid로 fallback
            logger.warning(f"SES failed, falling back to SendGrid: {result}")
            return self.sendgrid_service.send_email(
                to_addresses, subject, html_body, text_body
            )

        else:
            # SendGrid primary
            result = self.sendgrid_service.send_email(
                to_addresses, subject, html_body, text_body
            )

            if result['success']:
                return result

            # SendGrid 실패 시 SES로 fallback
            logger.warning(f"SendGrid failed, falling back to SES: {result}")
            return self.ses_service.send_email(
                to_addresses, subject, html_body, text_body, **kwargs
            )
```

---

## 이메일 템플릿 시스템

### 1. MJML 템플릿 베이스

```xml
<!-- app/email_templates/base.mjml -->
<mjml>
  <mj-head>
    <mj-title>{{title}}</mj-title>
    <mj-preview>{{preview_text}}</mj-preview>
    <mj-attributes>
      <mj-all font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"></mj-all>
      <mj-text font-size="14px" color="#333333" line-height="1.6"></mj-text>
      <mj-button background-color="#4F46E5" color="#ffffff" border-radius="6px"></mj-button>
    </mj-attributes>
    <mj-style inline="inline">
      .footer-link { color: #6B7280 !important; text-decoration: none; }
      .footer-link:hover { color: #4F46E5 !important; }
    </mj-style>
  </mj-head>

  <mj-body background-color="#F3F4F6">
    <!-- Header -->
    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-image
          src="https://cdn.pingvasai.com/logo.png"
          width="150px"
          alt="PingvasAI"
        ></mj-image>
      </mj-column>
    </mj-section>

    <!-- Content -->
    <mj-section background-color="#ffffff" padding="40px 20px">
      <mj-column>
        {% block content %}
        <!-- 이메일별 컨텐츠 -->
        {% endblock %}
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section background-color="#F9FAFB" padding="40px 20px">
      <mj-column>
        <mj-text align="center" font-size="12px" color="#6B7280">
          <p>
            © 2025 PingvasAI. All rights reserved.<br/>
            123 AI Street, San Francisco, CA 94102
          </p>
          <p>
            <a href="{{unsubscribe_url}}" class="footer-link">Unsubscribe</a> |
            <a href="https://pingvasai.com/privacy" class="footer-link">Privacy Policy</a> |
            <a href="https://pingvasai.com/terms" class="footer-link">Terms of Service</a>
          </p>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```

### 2. Jinja2 템플릿 렌더러

```python
# app/services/email_template_service.py
from jinja2 import Environment, FileSystemLoader, select_autoescape
import subprocess
import os
from pathlib import Path

class EmailTemplateService:
    """이메일 템플릿 렌더링 서비스"""

    def __init__(self):
        template_dir = Path(__file__).parent.parent / "email_templates"
        self.jinja_env = Environment(
            loader=FileSystemLoader(str(template_dir)),
            autoescape=select_autoescape(['html', 'xml', 'mjml'])
        )

    def render_template(
        self,
        template_name: str,
        context: Dict[str, Any]
    ) -> Dict[str, str]:
        """
        템플릿 렌더링

        Args:
            template_name: 템플릿 파일명 (예: "welcome.mjml")
            context: 템플릿 변수

        Returns:
            {'html': '...', 'text': '...'}
        """

        # MJML 템플릿 렌더링
        mjml_template = self.jinja_env.get_template(template_name)
        mjml_content = mjml_template.render(**context)

        # MJML -> HTML 변환
        html_content = self.mjml_to_html(mjml_content)

        # 텍스트 버전 생성 (HTML에서 태그 제거)
        text_content = self.html_to_text(html_content)

        return {
            'html': html_content,
            'text': text_content
        }

    def mjml_to_html(self, mjml_content: str) -> str:
        """MJML을 HTML로 변환"""

        # Node.js mjml CLI 사용
        # npm install -g mjml 필요
        process = subprocess.Popen(
            ['mjml', '-s'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        stdout, stderr = process.communicate(input=mjml_content)

        if process.returncode != 0:
            logger.error(f"MJML conversion failed: {stderr}")
            raise Exception(f"MJML conversion error: {stderr}")

        return stdout

    def html_to_text(self, html_content: str) -> str:
        """HTML을 플레인 텍스트로 변환"""
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html_content, 'html.parser')

        # 링크는 [text](url) 형태로
        for link in soup.find_all('a'):
            link.replace_with(f"{link.get_text()} ({link.get('href', '')})")

        # 텍스트 추출
        text = soup.get_text()

        # 불필요한 공백 제거
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return '\n\n'.join(lines)


# 전역 인스턴스
template_service = EmailTemplateService()
```

### 3. 이메일 템플릿 예제

#### 회원가입 환영 이메일

```xml
<!-- app/email_templates/welcome.mjml -->
{% extends "base.mjml" %}

{% block content %}
<mj-text font-size="24px" font-weight="bold" color="#111827">
  Welcome to PingvasAI, {{username}}! 🎨
</mj-text>

<mj-text>
  Thank you for joining PingvasAI. We're excited to help you create amazing AI-generated images!
</mj-text>

<mj-text>
  <strong>Your account details:</strong><br/>
  Email: {{email}}<br/>
  Plan: {{plan_name}}<br/>
  Credits: {{credits}} credits
</mj-text>

<mj-button href="{{verify_email_url}}">
  Verify Your Email
</mj-button>

<mj-text>
  Or copy and paste this link into your browser:<br/>
  <a href="{{verify_email_url}}">{{verify_email_url}}</a>
</mj-text>

<mj-divider border-color="#E5E7EB"></mj-divider>

<mj-text font-weight="bold">
  Getting Started:
</mj-text>

<mj-text>
  <ul style="padding-left: 20px;">
    <li>Verify your email address</li>
    <li>Create your first AI image</li>
    <li>Explore our model library</li>
    <li>Join our Discord community</li>
  </ul>
</mj-text>

<mj-button href="https://pingvasai.com/dashboard">
  Go to Dashboard
</mj-button>
{% endblock %}
```

#### 비밀번호 재설정 이메일

```xml
<!-- app/email_templates/password_reset.mjml -->
{% extends "base.mjml" %}

{% block content %}
<mj-text font-size="24px" font-weight="bold" color="#111827">
  Reset Your Password
</mj-text>

<mj-text>
  We received a request to reset the password for your PingvasAI account ({{email}}).
</mj-text>

<mj-text>
  Click the button below to reset your password. This link will expire in <strong>1 hour</strong>.
</mj-text>

<mj-button href="{{reset_url}}">
  Reset Password
</mj-button>

<mj-text>
  Or copy and paste this link into your browser:<br/>
  <a href="{{reset_url}}">{{reset_url}}</a>
</mj-text>

<mj-divider border-color="#E5E7EB"></mj-divider>

<mj-text color="#DC2626" font-weight="bold">
  ⚠️ Security Notice
</mj-text>

<mj-text>
  If you didn't request this password reset, please ignore this email or contact our support team if you have concerns.
</mj-text>

<mj-text font-size="12px" color="#6B7280">
  This password reset link was requested from IP: {{ip_address}} at {{timestamp}}.
</mj-text>
{% endblock %}
```

#### 구독 변경 이메일

```xml
<!-- app/email_templates/subscription_changed.mjml -->
{% extends "base.mjml" %}

{% block content %}
<mj-text font-size="24px" font-weight="bold" color="#111827">
  Your Subscription Has Been Updated
</mj-text>

<mj-text>
  Hi {{username}},
</mj-text>

<mj-text>
  Your PingvasAI subscription has been successfully updated!
</mj-text>

<mj-section background-color="#F9FAFB" border-radius="8px" padding="20px">
  <mj-column>
    <mj-text>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; font-weight: bold;">Previous Plan:</td>
          <td style="padding: 8px;">{{old_plan}}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">New Plan:</td>
          <td style="padding: 8px; color: #10B981;">{{new_plan}}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">Monthly Credits:</td>
          <td style="padding: 8px;">{{monthly_credits}} credits</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">Storage:</td>
          <td style="padding: 8px;">{{storage_gb}} GB</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">Price:</td>
          <td style="padding: 8px;">${{price}}/{{billing_cycle}}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">Next Billing Date:</td>
          <td style="padding: 8px;">{{next_billing_date}}</td>
        </tr>
      </table>
    </mj-text>
  </mj-column>
</mj-section>

<mj-text>
  Your new credits have been added to your account and are ready to use!
</mj-text>

<mj-button href="https://pingvasai.com/dashboard">
  View Dashboard
</mj-button>

<mj-divider border-color="#E5E7EB"></mj-divider>

<mj-text font-size="12px" color="#6B7280">
  Questions? Contact us at <a href="mailto:support@pingvasai.com">support@pingvasai.com</a>
</mj-text>
{% endblock %}
```

#### 크레딧 부족 알림

```xml
<!-- app/email_templates/low_credits.mjml -->
{% extends "base.mjml" %}

{% block content %}
<mj-text font-size="24px" font-weight="bold" color="#DC2626">
  ⚠️ Your Credits Are Running Low
</mj-text>

<mj-text>
  Hi {{username}},
</mj-text>

<mj-text>
  Your PingvasAI account is running low on credits. You currently have <strong>{{credits_remaining}} credits</strong> remaining.
</mj-text>

<mj-section background-color="#FEF2F2" border-left="4px solid #DC2626" padding="20px">
  <mj-column>
    <mj-text color="#DC2626" font-weight="bold">
      Current Balance: {{credits_remaining}} credits
    </mj-text>
    <mj-text>
      This is approximately {{estimated_images}} more images at your current usage rate.
    </mj-text>
  </mj-column>
</mj-section>

<mj-text font-weight="bold">
  What happens when you run out?
</mj-text>

<mj-text>
  <ul style="padding-left: 20px;">
    <li>Your image generation will be paused</li>
    <li>Existing images remain accessible</li>
    <li>You can upgrade or purchase more credits anytime</li>
  </ul>
</mj-text>

<mj-button href="https://pingvasai.com/pricing">
  Add More Credits
</mj-button>

<mj-divider border-color="#E5E7EB"></mj-divider>

<mj-text>
  Your credits will automatically reset to {{monthly_credits}} on {{reset_date}} when your subscription renews.
</mj-text>
{% endblock %}
```

---

## 트랜잭션 이메일

### 1. Database Schema

```sql
-- 이메일 발송 로그
CREATE TABLE email_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    email_type VARCHAR(50) NOT NULL,  -- welcome, password_reset, subscription_changed, etc.
    recipient_email VARCHAR(255) NOT NULL,
    subject VARCHAR(500),
    status VARCHAR(20) DEFAULT 'pending',  -- pending, sent, failed, bounced, complained
    provider VARCHAR(20),  -- ses, sendgrid
    message_id VARCHAR(255),  -- Provider message ID
    error_message TEXT,

    -- 추적
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP,
    opened_at TIMESTAMP,
    clicked_at TIMESTAMP,
    bounced_at TIMESTAMP,
    complained_at TIMESTAMP,

    -- 메타데이터
    template_data JSONB,
    ip_address INET,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email_logs_user ON email_logs(user_id, created_at DESC);
CREATE INDEX idx_email_logs_type ON email_logs(email_type, created_at DESC);
CREATE INDEX idx_email_logs_status ON email_logs(status);
CREATE INDEX idx_email_logs_message_id ON email_logs(message_id);

-- 이메일 검증 토큰
CREATE TABLE email_verification_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token) WHERE verified_at IS NULL;
CREATE INDEX idx_email_verification_tokens_user ON email_verification_tokens(user_id);

-- 이메일 수신거부
CREATE TABLE email_unsubscribes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    unsubscribed_from JSONB DEFAULT '[]',  -- ["newsletter", "marketing", "product_updates"]
    unsubscribe_all BOOLEAN DEFAULT FALSE,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email_unsubscribes_email ON email_unsubscribes(email);
```

### 2. 이메일 발송 함수

```python
# app/services/transactional_email.py
from app.services.unified_email_service import UnifiedEmailService
from app.services.email_template_service import template_service
from app.models import EmailLog, EmailVerificationToken
from sqlalchemy.ext.asyncio import AsyncSession
import secrets
from datetime import datetime, timedelta

email_service = UnifiedEmailService()


async def send_welcome_email(
    user: User,
    db: AsyncSession
) -> Dict[str, Any]:
    """회원가입 환영 이메일 + 이메일 검증"""

    # 1. 이메일 검증 토큰 생성
    verification_token = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(hours=24)

    token_record = EmailVerificationToken(
        user_id=user.user_id,
        token=verification_token,
        email=user.email,
        expires_at=expires_at
    )
    db.add(token_record)
    await db.flush()

    # 2. 템플릿 렌더링
    verify_url = f"https://pingvasai.com/verify-email?token={verification_token}"

    context = {
        'title': 'Welcome to PingvasAI',
        'preview_text': 'Verify your email and start creating!',
        'username': user.username,
        'email': user.email,
        'plan_name': user.subscription_plan.title(),
        'credits': user.credits_balance,
        'verify_email_url': verify_url,
        'unsubscribe_url': f"https://pingvasai.com/unsubscribe?email={user.email}"
    }

    rendered = template_service.render_template('welcome.mjml', context)

    # 3. 이메일 발송
    result = await email_service.send_email(
        to_addresses=[user.email],
        subject='Welcome to PingvasAI - Verify Your Email',
        html_body=rendered['html'],
        text_body=rendered['text'],
        configuration_set='transactional-emails',
        tags={'email_type': 'welcome', 'user_id': str(user.user_id)}
    )

    # 4. 로그 기록
    email_log = EmailLog(
        user_id=user.user_id,
        email_type='welcome',
        recipient_email=user.email,
        subject='Welcome to PingvasAI - Verify Your Email',
        status='sent' if result['success'] else 'failed',
        provider='ses',  # or result['provider']
        message_id=result.get('message_id'),
        error_message=result.get('error_message'),
        template_data=context,
        sent_at=datetime.utcnow() if result['success'] else None
    )
    db.add(email_log)
    await db.commit()

    return result


async def send_password_reset_email(
    email: str,
    reset_token: str,
    ip_address: str,
    db: AsyncSession
) -> Dict[str, Any]:
    """비밀번호 재설정 이메일"""

    reset_url = f"https://pingvasai.com/reset-password?token={reset_token}"

    context = {
        'title': 'Reset Your Password',
        'preview_text': 'Click here to reset your password',
        'email': email,
        'reset_url': reset_url,
        'ip_address': ip_address,
        'timestamp': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC'),
        'unsubscribe_url': f"https://pingvasai.com/unsubscribe?email={email}"
    }

    rendered = template_service.render_template('password_reset.mjml', context)

    result = await email_service.send_email(
        to_addresses=[email],
        subject='Reset Your PingvasAI Password',
        html_body=rendered['html'],
        text_body=rendered['text'],
        configuration_set='transactional-emails',
        tags={'email_type': 'password_reset'}
    )

    # 로그 기록
    email_log = EmailLog(
        email_type='password_reset',
        recipient_email=email,
        subject='Reset Your PingvasAI Password',
        status='sent' if result['success'] else 'failed',
        provider='ses',
        message_id=result.get('message_id'),
        template_data=context,
        ip_address=ip_address,
        sent_at=datetime.utcnow() if result['success'] else None
    )
    db.add(email_log)
    await db.commit()

    return result


async def send_subscription_changed_email(
    user: User,
    old_plan: str,
    new_plan: str,
    db: AsyncSession
) -> Dict[str, Any]:
    """구독 플랜 변경 알림"""

    plan_details = SUBSCRIPTION_PLANS[new_plan]

    context = {
        'title': 'Subscription Updated',
        'preview_text': f'Your plan has been changed to {new_plan}',
        'username': user.username,
        'old_plan': old_plan.title(),
        'new_plan': new_plan.title(),
        'monthly_credits': plan_details['monthly_credits'],
        'storage_gb': plan_details['storage_gb'],
        'price': plan_details.get('monthly_price', 0) / 100,
        'billing_cycle': user.subscription_billing_cycle or 'monthly',
        'next_billing_date': user.subscription_current_period_end.strftime('%Y-%m-%d') if user.subscription_current_period_end else 'N/A',
        'unsubscribe_url': f"https://pingvasai.com/unsubscribe?email={user.email}"
    }

    rendered = template_service.render_template('subscription_changed.mjml', context)

    result = await email_service.send_email(
        to_addresses=[user.email],
        subject=f'Your Subscription Has Been Updated to {new_plan.title()}',
        html_body=rendered['html'],
        text_body=rendered['text'],
        configuration_set='transactional-emails',
        tags={'email_type': 'subscription_changed', 'user_id': str(user.user_id)}
    )

    email_log = EmailLog(
        user_id=user.user_id,
        email_type='subscription_changed',
        recipient_email=user.email,
        subject=f'Your Subscription Has Been Updated to {new_plan.title()}',
        status='sent' if result['success'] else 'failed',
        provider='ses',
        message_id=result.get('message_id'),
        template_data=context,
        sent_at=datetime.utcnow() if result['success'] else None
    )
    db.add(email_log)
    await db.commit()

    return result


async def send_low_credits_alert(
    user: User,
    db: AsyncSession
) -> Dict[str, Any]:
    """크레딧 부족 알림 (10% 이하)"""

    monthly_credits = SUBSCRIPTION_PLANS[user.subscription_plan]['monthly_credits']
    estimated_images = user.credits_balance // 50  # 평균 50 크레딧/이미지 가정

    # 다음 리셋 날짜
    if user.subscription_current_period_end:
        reset_date = user.subscription_current_period_end.strftime('%B %d, %Y')
    else:
        reset_date = "your next billing date"

    context = {
        'title': 'Low Credits Alert',
        'preview_text': f'You have {user.credits_balance} credits remaining',
        'username': user.username,
        'credits_remaining': user.credits_balance,
        'estimated_images': estimated_images,
        'monthly_credits': monthly_credits,
        'reset_date': reset_date,
        'unsubscribe_url': f"https://pingvasai.com/unsubscribe?email={user.email}&type=alerts"
    }

    rendered = template_service.render_template('low_credits.mjml', context)

    result = await email_service.send_email(
        to_addresses=[user.email],
        subject='⚠️ Your PingvasAI Credits Are Running Low',
        html_body=rendered['html'],
        text_body=rendered['text'],
        configuration_set='transactional-emails',
        tags={'email_type': 'low_credits', 'user_id': str(user.user_id)}
    )

    email_log = EmailLog(
        user_id=user.user_id,
        email_type='low_credits',
        recipient_email=user.email,
        subject='⚠️ Your PingvasAI Credits Are Running Low',
        status='sent' if result['success'] else 'failed',
        provider='ses',
        message_id=result.get('message_id'),
        template_data=context,
        sent_at=datetime.utcnow() if result['success'] else None
    )
    db.add(email_log)
    await db.commit()

    return result
```

### 3. Celery 비동기 이메일 발송

```python
# app/worker/email_tasks.py
from celery import shared_task
from app.services.transactional_email import (
    send_welcome_email,
    send_password_reset_email,
    send_subscription_changed_email,
    send_low_credits_alert
)
from app.database import get_db


@shared_task(name="send_welcome_email_task")
def send_welcome_email_task(user_id: str):
    """회원가입 환영 이메일 발송 (비동기)"""
    async def _send():
        async with get_db() as db:
            user = await db.get(User, user_id)
            if user:
                await send_welcome_email(user, db)

    import asyncio
    asyncio.run(_send())


@shared_task(name="send_password_reset_email_task")
def send_password_reset_email_task(email: str, reset_token: str, ip_address: str):
    """비밀번호 재설정 이메일 발송 (비동기)"""
    async def _send():
        async with get_db() as db:
            await send_password_reset_email(email, reset_token, ip_address, db)

    import asyncio
    asyncio.run(_send())


@shared_task(name="check_low_credits")
def check_low_credits_task():
    """
    크레딧 부족 사용자 확인 및 알림 발송

    매일 1회 실행 (Celery Beat)
    """
    async def _check():
        async with get_db() as db:
            # 크레딧이 월간 할당량의 10% 이하인 사용자 조회
            stmt = select(User).where(
                User.subscription_plan != 'free',
                User.credits_balance < (User.purchased_credits * 0.1)
            )
            result = await db.execute(stmt)
            low_credit_users = result.scalars().all()

            for user in low_credit_users:
                # 지난 7일 이내 이미 알림을 보낸 경우 스킵
                recent_alert_stmt = select(EmailLog).where(
                    EmailLog.user_id == user.user_id,
                    EmailLog.email_type == 'low_credits',
                    EmailLog.created_at >= datetime.utcnow() - timedelta(days=7)
                )
                recent_alert = (await db.execute(recent_alert_stmt)).scalar_one_or_none()

                if not recent_alert:
                    await send_low_credits_alert(user, db)

    import asyncio
    asyncio.run(_check())


# Celery Beat 스케줄 설정
# celeryconfig.py
beat_schedule = {
    'check-low-credits-daily': {
        'task': 'check_low_credits',
        'schedule': crontab(hour=10, minute=0),  # 매일 오전 10시
    },
}
```

---

## 마케팅 이메일 (뉴스레터)

### 1. 뉴스레터 구독 관리

```python
# app/api/v1/newsletter.py
from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr

router = APIRouter(prefix="/newsletter", tags=["Newsletter"])


class NewsletterSubscribeRequest(BaseModel):
    email: EmailStr
    categories: List[str] = ["product_updates", "tips", "promotions"]


@router.post("/subscribe")
async def subscribe_to_newsletter(
    request: NewsletterSubscribeRequest,
    db: AsyncSession = Depends(get_db)
):
    """뉴스레터 구독"""

    # 기존 구독 확인
    stmt = select(EmailUnsubscribe).where(EmailUnsubscribe.email == request.email)
    result = await db.execute(stmt)
    unsubscribe = result.scalar_one_or_none()

    if unsubscribe:
        # 이전 구독 취소 기록이 있으면 업데이트
        unsubscribe.unsubscribe_all = False
        unsubscribe.unsubscribed_from = []
    else:
        # 없으면 새로 생성 (구독 상태)
        unsubscribe = EmailUnsubscribe(
            email=request.email,
            unsubscribe_all=False,
            unsubscribed_from=[]
        )
        db.add(unsubscribe)

    await db.commit()

    # 환영 이메일 발송
    await send_newsletter_welcome_email(request.email, request.categories, db)

    return {"message": "Successfully subscribed to newsletter"}


@router.post("/unsubscribe")
async def unsubscribe_from_newsletter(
    email: EmailStr,
    categories: Optional[List[str]] = None,
    unsubscribe_all: bool = False,
    db: AsyncSession = Depends(get_db)
):
    """뉴스레터 구독 취소"""

    stmt = select(EmailUnsubscribe).where(EmailUnsubscribe.email == email)
    result = await db.execute(stmt)
    unsubscribe = result.scalar_one_or_none()

    if not unsubscribe:
        unsubscribe = EmailUnsubscribe(email=email)
        db.add(unsubscribe)

    if unsubscribe_all:
        unsubscribe.unsubscribe_all = True
        unsubscribe.unsubscribed_from = []
    elif categories:
        current = set(unsubscribe.unsubscribed_from or [])
        current.update(categories)
        unsubscribe.unsubscribed_from = list(current)

    await db.commit()

    return {"message": "Successfully unsubscribed"}


async def send_newsletter_welcome_email(
    email: str,
    categories: List[str],
    db: AsyncSession
):
    """뉴스레터 구독 환영 이메일"""
    # 템플릿 렌더링 및 발송
    # ...
```

### 2. 대량 이메일 발송

```python
# app/services/newsletter_service.py
class NewsletterService:
    """뉴스레터 대량 발송 서비스"""

    def __init__(self):
        self.email_service = UnifiedEmailService()

    async def send_newsletter(
        self,
        template_name: str,
        subject: str,
        context: Dict[str, Any],
        categories: List[str],
        db: AsyncSession
    ):
        """
        뉴스레터 대량 발송

        Args:
            template_name: 템플릿 파일명
            subject: 제목
            context: 템플릿 변수 (공통)
            categories: 발송 대상 카테고리
        """

        # 1. 수신 대상 조회 (구독 취소 제외)
        stmt = select(User.email, User.username).outerjoin(
            EmailUnsubscribe,
            User.email == EmailUnsubscribe.email
        ).where(
            or_(
                EmailUnsubscribe.email.is_(None),  # 구독 취소 기록 없음
                and_(
                    EmailUnsubscribe.unsubscribe_all == False,
                    not_(EmailUnsubscribe.unsubscribed_from.contains(categories))
                )
            )
        )

        result = await db.execute(stmt)
        recipients = result.all()

        logger.info(f"Sending newsletter to {len(recipients)} recipients")

        # 2. 배치 발송 (100명씩)
        batch_size = 100
        for i in range(0, len(recipients), batch_size):
            batch = recipients[i:i + batch_size]

            # Celery 비동기 작업
            send_newsletter_batch.delay(
                template_name=template_name,
                subject=subject,
                context=context,
                recipients=[(email, username) for email, username in batch]
            )

        return {
            "message": f"Newsletter queued for {len(recipients)} recipients",
            "total_recipients": len(recipients)
        }


@shared_task(name="send_newsletter_batch")
def send_newsletter_batch(
    template_name: str,
    subject: str,
    context: Dict[str, Any],
    recipients: List[Tuple[str, str]]
):
    """뉴스레터 배치 발송 (Celery)"""

    async def _send():
        async with get_db() as db:
            for email, username in recipients:
                # 개인화된 컨텍스트
                personalized_context = {
                    **context,
                    'username': username,
                    'unsubscribe_url': f"https://pingvasai.com/unsubscribe?email={email}"
                }

                # 템플릿 렌더링
                rendered = template_service.render_template(template_name, personalized_context)

                # 발송
                result = await email_service.send_email(
                    to_addresses=[email],
                    subject=subject,
                    html_body=rendered['html'],
                    text_body=rendered['text'],
                    configuration_set='marketing-emails',
                    tags={'email_type': 'newsletter'}
                )

                # 로그
                email_log = EmailLog(
                    email_type='newsletter',
                    recipient_email=email,
                    subject=subject,
                    status='sent' if result['success'] else 'failed',
                    provider='ses',
                    message_id=result.get('message_id'),
                    sent_at=datetime.utcnow() if result['success'] else None
                )
                db.add(email_log)

                # Rate limiting (SES: 14 emails/sec)
                await asyncio.sleep(0.1)

            await db.commit()

    import asyncio
    asyncio.run(_send())
```

---

## 이메일 로그 및 추적

### 1. SES Event Publishing 설정

```bash
# SNS Topic 생성
aws sns create-topic --name ses-email-events

# SES Configuration Set 생성
aws ses create-configuration-set --configuration-set Name=transactional-emails

# Event Destination 추가 (SNS)
aws ses put-configuration-set-event-destination \
  --configuration-set-name transactional-emails \
  --event-destination '{
    "Name": "email-events",
    "Enabled": true,
    "MatchingEventTypes": ["send", "bounce", "complaint", "delivery", "open", "click"],
    "SNSDestination": {
      "TopicARN": "arn:aws:sns:us-east-1:123456789:ses-email-events"
    }
  }'
```

### 2. SNS Webhook 처리

```python
# app/api/webhooks/ses_events.py
from fastapi import APIRouter, Request, HTTPException
import json
import base64

router = APIRouter(prefix="/webhooks/ses", tags=["Webhooks"])


@router.post("/events")
async def handle_ses_events(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """SES 이벤트 웹훅 처리"""

    body = await request.body()
    payload = json.loads(body)

    # SNS 메시지 타입 확인
    message_type = request.headers.get("x-amz-sns-message-type")

    if message_type == "SubscriptionConfirmation":
        # SNS 구독 확인
        subscribe_url = payload.get("SubscribeURL")
        if subscribe_url:
            # 구독 URL 방문 (자동 확인)
            import httpx
            async with httpx.AsyncClient() as client:
                await client.get(subscribe_url)
            return {"message": "Subscription confirmed"}

    elif message_type == "Notification":
        # 이벤트 처리
        message = json.loads(payload.get("Message", "{}"))
        event_type = message.get("eventType")

        if event_type == "Delivery":
            await handle_delivery_event(message, db)
        elif event_type == "Bounce":
            await handle_bounce_event(message, db)
        elif event_type == "Complaint":
            await handle_complaint_event(message, db)
        elif event_type == "Open":
            await handle_open_event(message, db)
        elif event_type == "Click":
            await handle_click_event(message, db)

    return {"status": "processed"}


async def handle_delivery_event(message: dict, db: AsyncSession):
    """배달 완료 이벤트"""
    mail = message.get("mail", {})
    message_id = mail.get("messageId")

    # 이메일 로그 업데이트
    stmt = select(EmailLog).where(EmailLog.message_id == message_id)
    result = await db.execute(stmt)
    log = result.scalar_one_or_none()

    if log:
        log.status = "delivered"
        log.delivered_at = datetime.utcnow()
        await db.commit()


async def handle_bounce_event(message: dict, db: AsyncSession):
    """반송 이벤트 (메일 실패)"""
    mail = message.get("mail", {})
    bounce = message.get("bounce", {})

    message_id = mail.get("messageId")
    bounce_type = bounce.get("bounceType")  # Permanent or Transient

    stmt = select(EmailLog).where(EmailLog.message_id == message_id)
    result = await db.execute(stmt)
    log = result.scalar_one_or_none()

    if log:
        log.status = "bounced"
        log.bounced_at = datetime.utcnow()
        log.error_message = f"Bounce type: {bounce_type}"

        # Permanent bounce인 경우 자동 구독 취소
        if bounce_type == "Permanent":
            unsubscribe = EmailUnsubscribe(
                email=log.recipient_email,
                unsubscribe_all=True,
                reason="Permanent bounce"
            )
            db.add(unsubscribe)

        await db.commit()


async def handle_complaint_event(message: dict, db: AsyncSession):
    """스팸 신고 이벤트"""
    mail = message.get("mail", {})
    complaint = message.get("complaint", {})

    message_id = mail.get("messageId")
    complained_recipients = complaint.get("complainedRecipients", [])

    stmt = select(EmailLog).where(EmailLog.message_id == message_id)
    result = await db.execute(stmt)
    log = result.scalar_one_or_none()

    if log:
        log.status = "complained"
        log.complained_at = datetime.utcnow()

        # 자동 구독 취소
        for recipient in complained_recipients:
            email = recipient.get("emailAddress")
            if email:
                unsubscribe = EmailUnsubscribe(
                    email=email,
                    unsubscribe_all=True,
                    reason="Spam complaint"
                )
                db.add(unsubscribe)

        await db.commit()


async def handle_open_event(message: dict, db: AsyncSession):
    """이메일 열람 이벤트"""
    mail = message.get("mail", {})
    message_id = mail.get("messageId")

    stmt = select(EmailLog).where(EmailLog.message_id == message_id)
    result = await db.execute(stmt)
    log = result.scalar_one_or_none()

    if log and not log.opened_at:
        log.opened_at = datetime.utcnow()
        await db.commit()


async def handle_click_event(message: dict, db: AsyncSession):
    """링크 클릭 이벤트"""
    mail = message.get("mail", {})
    click = message.get("click", {})

    message_id = mail.get("messageId")
    link = click.get("link")

    stmt = select(EmailLog).where(EmailLog.message_id == message_id)
    result = await db.execute(stmt)
    log = result.scalar_one_or_none()

    if log and not log.clicked_at:
        log.clicked_at = datetime.utcnow()
        await db.commit()
```

### 3. 이메일 통계 API

```python
# app/api/v1/admin/email_statistics.py
@router.get("/email-statistics")
async def get_email_statistics(
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    email_type: Optional[str] = None,
    current_admin: User = Depends(require_admin("system", "read")),
    db: AsyncSession = Depends(get_db)
):
    """이메일 발송 통계"""

    if not start_date:
        start_date = datetime.utcnow() - timedelta(days=30)
    if not end_date:
        end_date = datetime.utcnow()

    # 기본 필터
    conditions = [
        EmailLog.created_at >= start_date,
        EmailLog.created_at <= end_date
    ]

    if email_type:
        conditions.append(EmailLog.email_type == email_type)

    # 전체 발송 수
    total_stmt = select(func.count(EmailLog.log_id)).where(*conditions)
    total_sent = (await db.execute(total_stmt)).scalar()

    # 상태별 집계
    status_stmt = select(
        EmailLog.status,
        func.count(EmailLog.log_id)
    ).where(*conditions).group_by(EmailLog.status)
    status_result = await db.execute(status_stmt)
    status_counts = {row[0]: row[1] for row in status_result}

    # 열람률 계산
    opened = (await db.execute(
        select(func.count(EmailLog.log_id)).where(
            *conditions,
            EmailLog.opened_at.isnot(None)
        )
    )).scalar()

    # 클릭률 계산
    clicked = (await db.execute(
        select(func.count(EmailLog.log_id)).where(
            *conditions,
            EmailLog.clicked_at.isnot(None)
        )
    )).scalar()

    # 반송률
    bounced = status_counts.get('bounced', 0)

    # 스팸 신고율
    complained = status_counts.get('complained', 0)

    return {
        "period": {
            "start": start_date.isoformat(),
            "end": end_date.isoformat()
        },
        "total_sent": total_sent,
        "status_breakdown": status_counts,
        "open_rate": round((opened / total_sent * 100), 2) if total_sent > 0 else 0,
        "click_rate": round((clicked / total_sent * 100), 2) if total_sent > 0 else 0,
        "bounce_rate": round((bounced / total_sent * 100), 2) if total_sent > 0 else 0,
        "complaint_rate": round((complained / total_sent * 100), 2) if total_sent > 0 else 0
    }
```

---

## 이메일 검증 및 보안

### 1. 이메일 검증 API

```python
# app/api/v1/email_verification.py
@router.get("/verify-email")
async def verify_email(
    token: str,
    db: AsyncSession = Depends(get_db)
):
    """이메일 검증"""

    # 토큰 조회
    stmt = select(EmailVerificationToken).where(
        EmailVerificationToken.token == token,
        EmailVerificationToken.verified_at.is_(None),
        EmailVerificationToken.expires_at > datetime.utcnow()
    )
    result = await db.execute(stmt)
    token_record = result.scalar_one_or_none()

    if not token_record:
        raise HTTPException(400, "Invalid or expired verification token")

    # 사용자 조회
    user = await db.get(User, token_record.user_id)
    if not user:
        raise HTTPException(404, "User not found")

    # 이메일 검증 완료
    user.email_verified = True
    token_record.verified_at = datetime.utcnow()

    await db.commit()

    return {
        "message": "Email verified successfully",
        "email": user.email
    }


@router.post("/resend-verification")
async def resend_verification_email(
    email: EmailStr,
    db: AsyncSession = Depends(get_db)
):
    """이메일 검증 링크 재발송"""

    # 사용자 조회
    stmt = select(User).where(User.email == email)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        # 보안상 이유로 성공 메시지 반환
        return {"message": "If the email exists, a verification link has been sent"}

    if user.email_verified:
        raise HTTPException(400, "Email already verified")

    # 기존 토큰 무효화
    await db.execute(
        update(EmailVerificationToken)
        .where(EmailVerificationToken.user_id == user.user_id)
        .values(verified_at=datetime.utcnow())
    )

    # 새 토큰 생성 및 이메일 발송
    await send_welcome_email(user, db)

    return {"message": "Verification email sent"}
```

### 2. 이메일 주소 검증 (실시간)

```python
# app/services/email_validator.py
import re
import dns.resolver
from typing import Dict, Any


class EmailValidator:
    """이메일 주소 검증 서비스"""

    @staticmethod
    def is_valid_format(email: str) -> bool:
        """이메일 형식 검증"""
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
        return bool(re.match(pattern, email))

    @staticmethod
    def check_mx_record(email: str) -> bool:
        """MX 레코드 확인 (도메인 유효성)"""
        try:
            domain = email.split('@')[1]
            mx_records = dns.resolver.resolve(domain, 'MX')
            return len(mx_records) > 0
        except:
            return False

    @staticmethod
    def is_disposable_email(email: str) -> bool:
        """일회용 이메일 차단"""
        disposable_domains = [
            'tempmail.com', 'guerrillamail.com', '10minutemail.com',
            'mailinator.com', 'throwaway.email', 'yopmail.com'
        ]

        domain = email.split('@')[1].lower()
        return domain in disposable_domains

    @classmethod
    def validate_email(cls, email: str) -> Dict[str, Any]:
        """전체 검증"""

        if not cls.is_valid_format(email):
            return {
                'valid': False,
                'reason': 'Invalid email format'
            }

        if cls.is_disposable_email(email):
            return {
                'valid': False,
                'reason': 'Disposable email addresses not allowed'
            }

        if not cls.check_mx_record(email):
            return {
                'valid': False,
                'reason': 'Domain does not have valid MX records'
            }

        return {
            'valid': True,
            'reason': 'Email is valid'
        }


# API 엔드포인트
@router.post("/validate-email")
async def validate_email_endpoint(email: EmailStr):
    """이메일 검증 API"""
    result = EmailValidator.validate_email(email)
    return result
```

### 3. Rate Limiting (이메일 발송)

```python
# app/middleware/email_rate_limit.py
from redis import Redis

redis_client = Redis(host='localhost', port=6379, db=0)


def check_email_rate_limit(user_id: str, limit: int = 10, window: int = 3600):
    """
    이메일 발송 Rate Limiting

    Args:
        user_id: 사용자 ID
        limit: 시간당 최대 발송 수
        window: 시간 윈도우 (초)

    Returns:
        bool: 발송 가능 여부
    """

    key = f"email_rate_limit:{user_id}"
    current_count = redis_client.get(key)

    if current_count and int(current_count) >= limit:
        return False

    # 카운트 증가
    pipe = redis_client.pipeline()
    pipe.incr(key)
    pipe.expire(key, window)
    pipe.execute()

    return True
```

---

## 테스트

### 1. 이메일 발송 테스트

```python
# tests/test_email_service.py
import pytest
from app.services.unified_email_service import UnifiedEmailService


@pytest.fixture
def email_service():
    return UnifiedEmailService()


def test_send_simple_email(email_service):
    """간단한 이메일 발송 테스트"""

    result = email_service.send_email(
        to_addresses=["test@example.com"],
        subject="Test Email",
        html_body="<h1>Hello</h1><p>This is a test email.</p>",
        text_body="Hello\n\nThis is a test email."
    )

    assert result['success'] == True
    assert 'message_id' in result


def test_send_with_template(email_service):
    """템플릿 이메일 발송 테스트"""

    from app.services.email_template_service import template_service

    context = {
        'title': 'Test Email',
        'preview_text': 'Test preview',
        'username': 'Test User',
        'email': 'test@example.com',
        'plan_name': 'Pro',
        'credits': 5000,
        'verify_email_url': 'https://example.com/verify',
        'unsubscribe_url': 'https://example.com/unsubscribe'
    }

    rendered = template_service.render_template('welcome.mjml', context)

    assert 'html' in rendered
    assert 'text' in rendered
    assert 'Test User' in rendered['html']


@pytest.mark.asyncio
async def test_welcome_email(test_user, test_db):
    """회원가입 환영 이메일 테스트"""

    from app.services.transactional_email import send_welcome_email

    result = await send_welcome_email(test_user, test_db)

    assert result['success'] == True

    # 이메일 로그 확인
    stmt = select(EmailLog).where(
        EmailLog.user_id == test_user.user_id,
        EmailLog.email_type == 'welcome'
    )
    log = (await test_db.execute(stmt)).scalar_one_or_none()

    assert log is not None
    assert log.status == 'sent'


@pytest.mark.asyncio
async def test_email_verification(test_db):
    """이메일 검증 토큰 테스트"""

    # 토큰 생성
    token = secrets.token_urlsafe(32)
    verification = EmailVerificationToken(
        user_id=test_user.user_id,
        token=token,
        email=test_user.email,
        expires_at=datetime.utcnow() + timedelta(hours=24)
    )
    test_db.add(verification)
    await test_db.commit()

    # 검증 API 호출
    response = client.get(f"/api/v1/verify-email?token={token}")

    assert response.status_code == 200
    assert response.json()['message'] == 'Email verified successfully'

    # DB 확인
    await test_db.refresh(test_user)
    assert test_user.email_verified == True


def test_email_rate_limit():
    """이메일 발송 Rate Limit 테스트"""

    from app.middleware.email_rate_limit import check_email_rate_limit

    user_id = "test_user_123"

    # 처음 10번은 성공
    for i in range(10):
        assert check_email_rate_limit(user_id, limit=10) == True

    # 11번째는 실패
    assert check_email_rate_limit(user_id, limit=10) == False
```

### 2. MJML 템플릿 테스트

```python
# tests/test_email_templates.py
def test_mjml_to_html():
    """MJML -> HTML 변환 테스트"""

    from app.services.email_template_service import template_service

    mjml = """
    <mjml>
      <mj-body>
        <mj-section>
          <mj-column>
            <mj-text>Hello World</mj-text>
          </mj-column>
        </mj-section>
      </mj-body>
    </mjml>
    """

    html = template_service.mjml_to_html(mjml)

    assert '<html' in html.lower()
    assert 'Hello World' in html


def test_all_templates_render():
    """모든 템플릿 렌더링 테스트"""

    from app.services.email_template_service import template_service

    templates = [
        ('welcome.mjml', {
            'title': 'Test',
            'preview_text': 'Test',
            'username': 'User',
            'email': 'test@test.com',
            'plan_name': 'Pro',
            'credits': 1000,
            'verify_email_url': 'http://example.com',
            'unsubscribe_url': 'http://example.com'
        }),
        ('password_reset.mjml', {
            'title': 'Test',
            'preview_text': 'Test',
            'email': 'test@test.com',
            'reset_url': 'http://example.com',
            'ip_address': '127.0.0.1',
            'timestamp': '2025-01-01 00:00:00',
            'unsubscribe_url': 'http://example.com'
        }),
    ]

    for template_name, context in templates:
        rendered = template_service.render_template(template_name, context)
        assert rendered['html']
        assert rendered['text']
        assert len(rendered['html']) > 100
```

---

## Phase 8 완료

### 구현 완료 항목

✅ **이메일 서비스 설정**
- Amazon SES 설정 및 도메인 인증
- SendGrid 백업 설정
- 통합 이메일 서비스 (Fallback)
- DNS 레코드 (SPF, DKIM, DMARC)

✅ **이메일 템플릿 시스템**
- MJML 템플릿 베이스
- Jinja2 렌더링
- HTML/텍스트 자동 변환
- 반응형 디자인

✅ **트랜잭션 이메일**
- 회원가입 환영 + 이메일 검증
- 비밀번호 재설정
- 구독 변경 알림
- 크레딧 부족 알림
- Celery 비동기 발송

✅ **마케팅 이메일**
- 뉴스레터 구독/취소 관리
- 대량 이메일 발송 (배치)
- 카테고리별 구독 관리

✅ **이메일 로그 및 추적**
- SES Event Publishing
- SNS Webhook 처리
- 열람률, 클릭률 추적
- 반송/스팸 신고 처리
- 통계 API

✅ **이메일 검증 및 보안**
- 이메일 검증 토큰
- 실시간 이메일 형식 검증
- MX 레코드 확인
- 일회용 이메일 차단
- Rate Limiting

✅ **테스트**
- 이메일 발송 테스트
- 템플릿 렌더링 테스트
- Rate Limit 테스트

---

**다음 단계: Phase 9 - Queue & Worker Optimization (우선순위 큐, OOM 방지)**
