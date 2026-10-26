export {
  ADDRESS_TOKEN_LENGTH,
  forwardingAddress,
  newAddressToken,
  tokenOfRecipient,
} from './address.ts';
export {
  AUTH_VERDICTS,
  authenticationFromHeaders,
  checkSender,
  parseAuthenticationResults,
  UNVERIFIED,
} from './authentication.ts';
export type { AuthVerdict, MailAuthentication, SenderCheck } from './authentication.ts';
export {
  DEFAULT_DEV_INBOUND_DOMAIN,
  DEFAULT_INBOX_DIR,
  EMAIL_INGEST_DRIVERS,
  EmailIngestConfigError,
  inboundDomainOf,
  loadEmailIngestConfig,
} from './config.ts';
export type { EmailIngestConfig, EmailIngestDriver } from './config.ts';
export { DEV_RECEIVER, dropInInbox, FolderMailSource } from './drivers/folder.ts';
export { s3MailBucket, SES_RECEIVER, SesMailSource, sqsMailQueue } from './drivers/ses.ts';
export type { MailBucket, MailQueue } from './drivers/ses.ts';
export type { MailSource, ReceivedMail } from './drivers/source.ts';
export {
  createEmailSaleTask,
  EMAIL_SALE_TASK_REASONS,
  emailSaleOfTask,
  recordEmailSale,
  standingSaleOf,
} from './email-sale.ts';
export type {
  EmailSaleDetails,
  EmailSaleTaskPayload,
  EmailSaleTaskReason,
  EmailSaleToRecord,
  NewEmailSaleTask,
} from './email-sale.ts';
export { readForwardingConfirmation } from './forwarding.ts';
export type { ForwardingConfirmation } from './forwarding.ts';
export { ensureSaleEmailInbox, findSaleEmailInbox, saveAskBeforeDelist } from './inbox.ts';
export type { SaleEmailInbox } from './inbox.ts';
export {
  createMailSource,
  EMAIL_INGEST_SCHEDULE,
  EMAIL_INGEST_TASK,
  runEmailIngest,
} from './job.ts';
export { matchEmailSale, MAX_CANDIDATES, normalizeTitle } from './match.ts';
export type { SaleMatch } from './match.ts';
export { MAX_MESSAGE_BYTES, readMessage, UnreadableMessageError } from './message.ts';
export type { MailMessage } from './message.ts';
export { parseSaleEmail, SOLD_EMAIL_TEMPLATES } from './parsers/index.ts';
export type { ParsedSale, SaleEmailParse, SaleEmailTemplate } from './parsers/index.ts';
export { processInboundEmail } from './process.ts';
export type { EmailOutcome, EmailProcessingDependencies } from './process.ts';
export { EXCERPT_LENGTH, redactedExcerpt } from './redact.ts';
export {
  classifySender,
  EMAIL_SALE_MARKETPLACES,
  FORWARDING_PROVIDERS,
  MARKETPLACE_SENDER_DOMAINS,
} from './senders.ts';
export type { EmailSaleMarketplace, Sender } from './senders.ts';
export { FORWARDING_STEPS, forwardingFilter } from './setup.ts';
