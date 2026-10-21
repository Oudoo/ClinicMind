import nodemailer from "nodemailer";
import { env } from "@/lib/env";

/**
 * Outbound e-mail for invitation and password-reset links.
 *
 * With `SMTP_URL` set, messages go out through nodemailer (any SMTP relay:
 * SES, Postmark, Mailgun, a Google Workspace account…). Without it the message
 * is written to the server log so a single-instance or local deployment still
 * works: operators copy the link from the log, and invitation links are also
 * returned to the inviting administrator. Reset links in logs are sensitive, so
 * configure SMTP before exposing the password-reset form to real users.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly name: "smtp" | "console";
  send(message: MailMessage): Promise<void>;
}

const consoleMailer: Mailer = {
  name: "console",
  async send(message) {
    console.info(
      `[mail] (no SMTP_URL configured — message logged, not sent)\n` +
        `  to:      ${message.to}\n` +
        `  subject: ${message.subject}\n` +
        message.text
          .split("\n")
          .map((line) => `  | ${line}`)
          .join("\n"),
    );
  },
};

let cached: Mailer | null = null;

export function mailer(): Mailer {
  if (cached) return cached;
  if (env.SMTP_URL) {
    const transport = nodemailer.createTransport(env.SMTP_URL);
    const from = env.MAIL_FROM ?? "ClinicMind <no-reply@localhost>";
    cached = {
      name: "smtp",
      async send(message) {
        await transport.sendMail({ from, ...message });
      },
    };
  } else {
    cached = consoleMailer;
  }
  return cached;
}

export async function sendMail(message: MailMessage): Promise<void> {
  await mailer().send(message);
}
