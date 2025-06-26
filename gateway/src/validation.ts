import { z } from 'zod';

// Common validation schemas
export const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');
export const TokenIdSchema = z.coerce.number().positive('Token ID must be positive');
export const PassportIdSchema = z.string().min(1, 'Passport ID is required');
export const BytesSchema = z.coerce.number().min(0, 'Bytes must be non-negative');
export const CostSchema = z.string().regex(/^\d+$/, 'Cost must be a valid wei amount');
export const FlowRateSchema = z.string().regex(/^\d+$/, 'Flow rate must be a valid wei per second');

// API Request Schemas
export const UsageQuerySchema = z.object({
  partnerId: z.string().optional(),
  since: z.coerce.number().optional(),
});

export const StreamStartSchema = z.object({
  passportId: PassportIdSchema,
  partnerId: z.string().min(1, 'Partner ID is required'),
  userAddress: AddressSchema,
  recipientAddress: AddressSchema,
  flowRate: FlowRateSchema,
});

export const StreamStopSchema = z.object({
  passportId: PassportIdSchema,
  partnerId: z.string().min(1, 'Partner ID is required'),
  userAddress: AddressSchema,
  recipientAddress: AddressSchema,
});

export const StreamingSessionSchema = z.object({
  passportId: PassportIdSchema,
  partnerId: z.string().min(1, 'Partner ID is required'),
  totalSize: z.coerce.number().positive('Total size must be positive'),
  costPerByte: CostSchema,
  chunkSize: z.coerce.number().positive('Chunk size must be positive').optional(),
});

export const DePINJobSchema = z.object({
  model: z.string().min(1, 'Model name is required'),
  input: z.record(z.any()).refine(data => Object.keys(data).length > 0, 'Input cannot be empty'),
  priority: z.enum(['cost', 'speed', 'reliability']).optional().default('cost'),
});

export const GitHubLinkSchema = z.object({
  walletAddress: AddressSchema,
  signature: z.string().min(1, 'Signature is required'),
  githubUserId: z.coerce.number().positive('GitHub user ID must be positive'),
});

// Request validation middleware factory
export const validateRequest = <T>(schema: z.ZodSchema<T>) => {
  return (data: unknown): T => {
    try {
      return schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
          code: e.code,
        }));
        
        throw new ValidationError('Request validation failed', issues);
      }
      throw error;
    }
  };
};

// Custom error classes
export class ValidationError extends Error {
  constructor(
    message: string,
    public issues: Array<{ field: string; message: string; code: string }>
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class ExternalServiceError extends Error {
  constructor(
    message: string,
    public service: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'ExternalServiceError';
  }
}

export class RateLimitError extends Error {
  constructor(message: string, public retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// Error response formatter
export const formatErrorResponse = (error: Error) => {
  const timestamp = new Date().toISOString();
  const requestId = Math.random().toString(36).substring(7);

  if (error instanceof ValidationError) {
    return {
      error: 'Validation Failed',
      message: error.message,
      issues: error.issues,
      timestamp,
      requestId,
    };
  }

  if (error instanceof AuthenticationError) {
    return {
      error: 'Authentication Failed',
      message: error.message,
      timestamp,
      requestId,
    };
  }

  if (error instanceof AuthorizationError) {
    return {
      error: 'Authorization Failed',
      message: error.message,
      timestamp,
      requestId,
    };
  }

  if (error instanceof ExternalServiceError) {
    return {
      error: 'External Service Error',
      message: error.message,
      service: error.service,
      statusCode: error.statusCode,
      timestamp,
      requestId,
    };
  }

  if (error instanceof RateLimitError) {
    return {
      error: 'Rate Limit Exceeded',
      message: error.message,
      retryAfter: error.retryAfter,
      timestamp,
      requestId,
    };
  }

  // Generic error (don't expose internal details in production)
  return {
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred' 
      : error.message,
    timestamp,
    requestId,
  };
};

// Request sanitization
export const sanitizeInput = {
  string: (input: unknown): string => {
    if (typeof input !== 'string') {
      throw new ValidationError('Expected string input', []);
    }
    return input.trim().replace(/[<>]/g, ''); // Basic XSS prevention
  },
  
  number: (input: unknown): number => {
    const num = Number(input);
    if (isNaN(num)) {
      throw new ValidationError('Expected numeric input', []);
    }
    return num;
  },
  
  address: (input: unknown): string => {
    const addr = sanitizeInput.string(input);
    return AddressSchema.parse(addr);
  },
};

// Rate limiting key generators
export const getRateLimitKey = (request: any): string => {
  const passportId = request.headers['x-passport-id'];
  const ip = request.ip;
  
  // Use passport ID if available, fallback to IP
  return passportId ? `passport:${passportId}` : `ip:${ip}`;
};

export const getPartnerRateLimitKey = (passportId: string, partnerId: string): string => {
  return `partner:${partnerId}:passport:${passportId}`;
};