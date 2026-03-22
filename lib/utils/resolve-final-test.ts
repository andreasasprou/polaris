export function sendEmail(to: string, subject: string, apiKey: string): void {
  // Bug: leaks API key
  console.log(`Sending to ${to}: ${subject} with key=${apiKey}`);
}
