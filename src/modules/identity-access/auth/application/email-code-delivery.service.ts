import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import type { VerificationCodePurpose } from '../infrastructure/email-verification-codes.repository.js';
import { EmailCodeTemplateService } from './email-code-template.service.js';

const RESEND_EMAIL_API_URL = 'https://api.resend.com/emails';
export const EMAIL_DELIVERY_FETCH = Symbol('EMAIL_DELIVERY_FETCH');
type FetchLike = typeof fetch;

export interface SendEmailCodeInput {
  email: string;
  code: string;
  purpose: VerificationCodePurpose;
}

@Injectable()
export class EmailCodeDeliveryService {
  private readonly config: AppConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly templateService: EmailCodeTemplateService,
    @Optional()
    @Inject(EMAIL_DELIVERY_FETCH)
    private readonly fetchFn: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    this.config = this.configService.getOrThrow<AppConfig>('app');
  }

  ensureReady(): void {
    const mode = this.deliveryMode();
    const nodeEnv = this.nodeEnvironment();

    if (mode === 'log' && nodeEnv !== 'production') {
      return;
    }

    if (
      mode === 'provider' &&
      this.config.email.provider === 'resend' &&
      this.config.email.apiKey &&
      this.config.email.from
    ) {
      return;
    }

    throw new ServiceUnavailableException(
      'Email verification delivery is not configured',
    );
  }

  async sendCode(input: SendEmailCodeInput): Promise<void> {
    this.ensureReady();

    const rendered = this.templateService.renderVerificationCodeEmail({
      email: input.email,
      code: input.code,
      expiresInMinutes: 10,
    });

    if (
      this.deliveryMode() === 'log' &&
      this.nodeEnvironment() !== 'production'
    ) {
      console.info(
        [
          `[auth-email-code] ${input.purpose} code for ${input.email}: ${input.code}`,
          `subject: ${rendered.subject}`,
          rendered.text,
        ].join('\n'),
      );
      return;
    }

    await this.sendWithResend({
      to: input.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  private async sendWithResend(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void> {
    const apiKey = this.config.email.apiKey;
    const from = this.config.email.from;

    if (!apiKey || !from) {
      throw new ServiceUnavailableException(
        'Email verification delivery is not configured',
      );
    }

    const response = await this.fetchFn(RESEND_EMAIL_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });

    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Email verification provider rejected the request (HTTP ${String(response.status)})`,
      );
    }
  }

  private deliveryMode(): 'log' | 'provider' | 'invalid' {
    return this.config.email.codeDelivery;
  }

  private nodeEnvironment(): string {
    return this.configService.get<string>('NODE_ENV') ?? 'development';
  }
}
