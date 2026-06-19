const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

function parseArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : '';
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = unquote(trimmed.slice(index + 1));

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function maskEmail(email) {
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) return email;
  return `${localPart.slice(0, 2)}***@${domain}`;
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));

  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = parseArg('from') || (process.env.RESEND_FROM || '').trim();
  const to = parseArg('to') || (process.env.RESEND_TEST_TO || '').trim();

  if (!apiKey || !from) {
    console.error('[Resend test] RESEND_API_KEY and RESEND_FROM are required. Set them in backend/.env or the shell environment.');
    process.exit(1);
  }

  if (!to) {
    console.error('[Resend test] Recipient is missing. Set RESEND_TEST_TO or pass --to=email@example.com.');
    process.exit(1);
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'TraSua POS Resend OTP test',
    text: `Ma OTP test cua ban la: ${otp}\nMa nay chi dung de kiem tra Resend.`,
  });

  if (error) {
    console.error(`[Resend test] Failed to send to ${maskEmail(to)} from "${from}".`);
    console.error(`[Resend test] ${error.name || 'Error'}: ${error.message || 'unknown error'}`);
    if (error.statusCode) {
      console.error(`[Resend test] statusCode=${error.statusCode}`);
    }
    process.exit(1);
  }

  console.log(`[Resend test] Accepted by Resend for ${maskEmail(to)} from "${from}".`);
  if (data && data.id) {
    console.log(`[Resend test] id=${data.id}`);
  }
  console.log(`[Resend test] otp=${otp}`);
}

main().catch((error) => {
  console.error(`[Resend test] Unexpected failure: ${error.message || error}`);
  process.exit(1);
});
