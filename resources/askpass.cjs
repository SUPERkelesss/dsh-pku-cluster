#!/usr/bin/env node
/**
 * askpass helper for the local (non-WSL) driver.
 *
 * OpenSSH runs this program instead of prompting on a terminal when
 * SSH_ASKPASS_REQUIRE=force is set. The cluster only offers password + OTP,
 * so the password and the one-time code are handed over in the environment of
 * the short-lived ssh process owned by the plugin — nothing touches the disk.
 *
 * ssh calls us once per prompt and passes the prompt text as arguments; we
 * answer with the password or the OTP depending on which prompt it is.
 *
 * Written for both the Windows driver (via askpass.cmd, because CreateProcess
 * cannot run a .js file) and POSIX hosts (via its shebang).
 */

const prompt = process.argv.slice(2).join(' ');
const password = process.env.PKU_ASKPASS_PASSWORD ?? '';
const otp = process.env.PKU_ASKPASS_OTP ?? '';

// "Verification Code:" / "One-time code:" / "Passcode:" are the OTP prompts;
// everything else is the account password.
const wantsOtp = /verification|one[\s-]?time|passcode|\botp\b/i.test(prompt);

process.stdout.write(`${wantsOtp ? otp : password}\n`);
