import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

export const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');
export const PassportIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9:_.-]{1,256}$/, 'Passport ID must be 1-256 characters of [A-Za-z0-9:_.-]');
/** A non-negative integer wei amount. */
export const WeiSchema = z.string().regex(/^\d+$/, 'Amount must be a non-negative integer in wei');
/** A positive wei-per-second flow rate (Superfluid rejects zero-rate flows). */
export const FlowRateSchema = WeiSchema.refine(
  // Zod still runs refinements after a failed regex check, so only digit strings are converted.
  (v) => !/^\d+$/.test(v) || BigInt(v) > 0n,
  'Flow rate must be positive'
);
export const SignatureSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{130}$/, 'Signature must be a 65-byte hex string');

export const UsageQuerySchema = z.object({
  partnerId: z.string().min(1).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
});

export const StreamPrepareSchema = z.object({
  sender: AddressSchema,
  receiver: AddressSchema,
  flowRate: FlowRateSchema,
});

export const StreamStartSchema = StreamPrepareSchema.extend({
  passportId: PassportIdSchema,
  partnerId: z.string().min(1, 'Partner ID is required'),
});

export const StreamStopSchema = z.object({
  passportId: PassportIdSchema,
  partnerId: z.string().min(1, 'Partner ID is required'),
});

export const StreamingSessionSchema = z.object({
  passportId: PassportIdSchema,
  partnerId: z.string().min(1, 'Partner ID is required'),
  totalSize: z.coerce.number().int().positive('Total size must be positive'),
  costPerByte: WeiSchema,
  chunkSize: z.coerce.number().int().positive('Chunk size must be positive').optional(),
});

export const DePINJobSchema = z.object({
  model: z.string().min(1, 'Model name is required'),
  input: z
    .record(z.unknown())
    .refine((data) => Object.keys(data).length > 0, 'Input cannot be empty'),
  priority: z.enum(['cost', 'speed', 'reliability']).default('cost'),
});

export const GitHubCallbackSchema = z.object({
  code: z.string().min(1, 'OAuth code is required'),
  state: z.string().min(1, 'OAuth state is required'),
});

export const GitHubLinkSchema = z.object({
  walletAddress: AddressSchema,
  signature: SignatureSchema,
  githubUserId: z.coerce.number().int().positive('GitHub user ID must be positive'),
});

export interface ValidationIssue {
  field: string;
  message: string;
  code: string;
}

/** Parse with a schema, converting Zod issues into a `ValidationError` (HTTP 400). */
export const validateRequest =
  <T>(schema: z.ZodSchema<T>) =>
  (data: unknown): T => {
    const result = schema.safeParse(data);
    if (result.success) {
      return result.data;
    }
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    throw new ValidationError('Request validation failed', issues);
  };

// ---------------------------------------------------------------------------------------------
// Errors: each maps to one HTTP status in the app's error handler.
// ---------------------------------------------------------------------------------------------

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly title: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends GatewayError {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = []
  ) {
    super(message, 400, 'Validation Failed');
  }
}

export class AuthenticationError extends GatewayError {
  constructor(message: string) {
    super(message, 401, 'Authentication Failed');
  }
}

export class AuthorizationError extends GatewayError {
  constructor(message: string) {
    super(message, 403, 'Authorization Failed');
  }
}

export class NotFoundError extends GatewayError {
  constructor(message: string) {
    super(message, 404, 'Not Found');
  }
}

export class ConflictError extends GatewayError {
  constructor(message: string) {
    super(message, 409, 'Conflict');
  }
}

export class RateLimitError extends GatewayError {
  constructor(
    message: string,
    public readonly resetTime?: Date
  ) {
    super(message, 429, 'Rate Limit Exceeded');
  }
}

/** A feature whose configuration (OAuth app, RPC endpoint, ...) is missing on this deployment. */
export class ServiceUnavailableError extends GatewayError {
  constructor(message: string) {
    super(message, 503, 'Service Unavailable');
  }
}

/** An upstream partner, node or chain RPC failed. */
export class ExternalServiceError extends GatewayError {
  constructor(
    message: string,
    public readonly service: string,
    statusCode = 502
  ) {
    super(message, statusCode, 'External Service Error');
  }
}

export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
  issues?: ValidationIssue[];
  service?: string;
  retryAfter?: string;
}

/** Shape every error response the same way. Internal error details are hidden in production. */
export function formatErrorResponse(error: unknown, statusCode: number): ErrorResponse {
  const timestamp = new Date().toISOString();

  if (error instanceof GatewayError) {
    const response: ErrorResponse = {
      error: error.title,
      message: error.message,
      statusCode: error.statusCode,
      timestamp,
    };
    if (error instanceof ValidationError) response.issues = error.issues;
    if (error instanceof ExternalServiceError) response.service = error.service;
    if (error instanceof RateLimitError && error.resetTime) {
      response.retryAfter = error.resetTime.toISOString();
    }
    return response;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (statusCode >= 500) {
    return {
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : message,
      statusCode,
      timestamp,
    };
  }
  return {
    error: statusCode === 404 ? 'Not Found' : 'Bad Request',
    message,
    statusCode,
    timestamp,
  };
}
