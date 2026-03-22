export function sendEmail(to: string, subject: string, apiKey: string): void {
  // Bug: logs the API key
  console.log(`Sending email to ${to}: ${subject} (key: ${apiKey})`);
}
