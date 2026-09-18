import { Injectable } from '@nestjs/common';

export interface RenderedVerificationEmail {
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class EmailCodeTemplateService {
  renderVerificationCodeEmail(input: {
    email: string;
    code: string;
    expiresInMinutes: number;
  }): RenderedVerificationEmail {
    const email = escapeHtml(input.email);
    const code = escapeHtml(input.code);
    const subject = 'Verify your AlphaCI email address';

    return {
      subject,
      html: [
        '<!doctype html><html><body>',
        '<h1>Verify your email</h1>',
        `<p>Enter this code to finish signing in to AlphaCI: <strong>${code}</strong></p>`,
        `<p>This code expires in ${String(input.expiresInMinutes)} minutes.</p>`,
        `<p>If you did not request this, you can ignore this message sent to ${email}.</p>`,
        '</body></html>',
      ].join(''),
      text: [
        'Verify your AlphaCI email',
        '',
        `Enter this code to finish signing in: ${input.code}`,
        `This code expires in ${String(input.expiresInMinutes)} minutes.`,
        'If you did not request this, you can ignore this message.',
      ].join('\n'),
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
