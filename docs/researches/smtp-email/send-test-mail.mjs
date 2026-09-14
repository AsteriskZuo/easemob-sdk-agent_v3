/**
 * SMTP 配置端到端验证脚本
 *
 * 用途：用 .easemob-agent/config.json 中的 APP__MAIL__* 配置真实发送一封测试邮件，
 *       验证 SMTP 连接、认证、发信全链路。
 *
 * 前置条件：项目已安装 nodemailer（健康自检功能落地后即为项目依赖）。
 *
 * 用法：
 *   node docs/researches/smtp-email/send-test-mail.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const config = JSON.parse(
  fs.readFileSync(path.join(repoRoot, '.easemob-agent', 'config.json'), 'utf8')
);

const host = config.APP__MAIL__SMTP_HOST;
const port = Number(config.APP__MAIL__SMTP_PORT);
const user = config.APP__MAIL__SMTP_USER;
const pass = config.APP__MAIL__SMTP_PASS;
const from = config.APP__MAIL__FROM;
const to = config.APP__MAIL__TO;

const required = { SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user, SMTP_PASS: pass, FROM: from, TO: to };
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`FAIL: 配置缺失 APP__MAIL__${key}`);
    process.exit(1);
  }
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465, // 465 = SSL；其他端口走 STARTTLS
  auth: { user, pass },
  connectionTimeout: 10000,
  socketTimeout: 15000,
});

try {
  await transporter.verify();
  console.log('1) SMTP 连接 + 认证成功 (verify OK)');

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const info = await transporter.sendMail({
    from,
    to,
    subject: `[easemob-agent] SMTP 配置验证测试 - ${now}`,
    text: `这是一封 SMTP 配置端到端验证邮件。\n\n时间: ${now}\nSMTP: ${host}:${port}\n发件人: ${from}\n\n收到此邮件说明健康自检的邮件通道配置正确。`,
  });
  console.log('2) 邮件发送成功, messageId =', info.messageId);
  console.log('   服务器响应:', info.response);
  console.log('   收件人:', to);
  console.log('RESULT: PASS');
} catch (err) {
  console.error('FAIL:', err.code || '', err.message);
  if (err.response) console.error('服务器响应:', err.response);
  console.log('RESULT: FAIL');
  process.exit(1);
}
