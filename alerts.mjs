/*
  Alert manager
  Handles:
  - Sending email alerts
  - Sending webhook alerts
  - Rate limiting both alert types
 */
import nodemailer from 'nodemailer'

import {readFile} from "node:fs/promises";
import {dirname, join} from "path";
import {fileURLToPath} from "url";

const {SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, SMTP_PORT, RECIPIENT, FROM_ADDRESS, EMAIL_COOLDOWN} = process.env

const mailEnabled = SMTP_HOST && SMTP_USERNAME

/* Based on SMTP2GO's port numbers: https://www.smtp2go.com/setup/ */
const implicitTLS = ["465", "8465", "443"]

let useImplicit = implicitTLS.includes(SMTP_PORT)

let transport;
if (mailEnabled) {
  transport = nodemailer.createTransport({
    logger: true,
    debug: false,
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: useImplicit,
    auth: {
      user: SMTP_USERNAME,
      pass: SMTP_PASSWORD,
    },
  });
}
const templatePromise = readFile(join(dirname(fileURLToPath(import.meta.url)), "alert-email.html"));

let lastEmailSentAt = 0

/**
 * Exported function. Verifies rate limits have not been violated, and sends the email via. enabled pathways.
 */

async function fillTemplate(values) {
  const template = await templatePromise

  const keys = Object.keys(values);
  let newString = `${template}`;
  for (const k of keys) {
    const exp = new RegExp(`{{${k}}}`, "g");
    newString = newString.replace(exp, values[k]);
  }
  return newString;
}

export async function reportIssue(fullReport, {orgName, reportId, contactInfo, domain}, {
  startTime,
  endTime
}, {successCount, failCount}, failures) {
  // Rate limit just to stop spam
  if (Date.now() - lastEmailSentAt < (EMAIL_COOLDOWN * 1000)) return console.log("Not sending email: Rate limited.")

  if (!mailEnabled) throw new Error("Can't send error - mail is not enabled.")

  const toEmails = RECIPIENT || false
  if (!toEmails) return console.log(`No recipients for domain ${domain}`)

  let failureReports = []
  for (let counter = 0; counter < failures.length; counter++) {
    const fail = failures[counter]
    const extraInfo = fail["additional-info-uri"] ? `<a href="${fail["additional-info-uri"]}">${fail["additional-info-uri"]}</a>` : ""
    failureReports.push(`<table
                <tr>
                    <td><strong>Failure ${counter}</strong></td>
                </tr>
                <tr>
                    <td>Result type</td>
                    <td>${fail["result-type"]}</td>
                </tr>
                <tr>
                    <td>Sender server IP</td>
                    <td>${fail["sending-mta-ip"]}</td>
                </tr>
                <tr>
                    <td>Receiver</td>
                    <td>${fail["receiving-mx-hostname"]} (${fail["receiving-ip"]})</td>
                </tr>
                <tr>
                    <td>No. Failed sessions</td>
                    <td>${fail["failed-session-count"]}</td>
                </tr>
                <tr>
                    <td>Additional information</td>
                    <td>${extraInfo}</td>
                </tr>
                <tr>
                    <td>Failure reason</td>
                    <td>${fail["failure-reason-code"]}</td>
                </tr>
            </table>`)
  }
  const start = new Date(startTime)
  const end = new Date(endTime)


  const fullHtmlEmail = await fillTemplate({
    orgName,
    contactInfo,
    reportId,
    domain,
    failureDetails: failureReports.join("\r\n"),
    date: `${start.getUTCDate()}/${start.getUTCMonth() + 1}/${start.getUTCFullYear()}`,
    start: `${start.getUTCHours()}:${start.getUTCMinutes()}`,
    end: `${end.getUTCHours()}:${end.getUTCMinutes()}`,
    subject: `TLS report from ${orgName} has error for ${domain}`,
    successCount,
    failureCount: failCount
  })


  const info = await transport.sendMail({
    from: FROM_ADDRESS,
    to: Array.isArray(toEmails) ? toEmails.join(",").slice(0, -1) : toEmails,
    subject: `TLS report from ${orgName} has failure for ${domain}`,
    text: fullHtmlEmail.replace(/<head>[\s\S]*<\/head>/, "").replace(/<[^>]*>/g, ""),
    html: fullHtmlEmail, // html body
    attachments: [
      {
        filename: "report.json",
        content: JSON.stringify(fullReport)
      }
    ]
  });
  lastEmailSentAt = Date.now()

  console.log("Message sent: %s", info.messageId);
}
