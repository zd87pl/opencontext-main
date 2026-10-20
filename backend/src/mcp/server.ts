/**
 * "MCP" endpoint for AI agents.
 *
 * This is a JSON-RPC-shaped HTTP API (`POST /mcp/tools/call`) with its own
 * API-key auth, rate limiting and tool schemas. It does not implement the Model
 * Context Protocol specification: there is no initialize handshake, no
 * stdio/streamable-HTTP transport, and the message shapes are ours. A real MCP
 * client cannot connect to it without an adapter.
 */
import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../common/logger.js';
import { MCPToolHandler } from './handlers/tool-handler.js';
import { MCPAuth } from './auth/mcp-auth.js';
import { MCPRateLimit } from './middleware/rate-limit.js';
import { AnalyticsService } from './services/analytics.service.js';

export const mcpRouter = Router();

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// MCP server configuration
const MCP_SERVER_CONFIG = {
  name: "opencontext",
  version: "1.0.0",
  description: "Universal AI content discovery and access",
  tools: [
    "search_premium_content",
    "get_content_metadata", 
    "purchase_content",
    "get_content",
    "track_usage",
    "manage_preferences"
  ]
};

// MCP request/response schemas
const MCPRequestSchema = z.object({
  method: z.string(),
  params: z.object({
    tool: z.string(),
    arguments: z.record(z.any())
  }),
  id: z.string(),
  jsonrpc: z.literal("2.0")
});

// Initialize services
const toolHandler = new MCPToolHandler();
const mcpAuth = new MCPAuth();
const mcpRateLimit = new MCPRateLimit();
const mcpAnalytics = new AnalyticsService();

/**
 * MCP Server Info - Returns server capabilities
 */
mcpRouter.get('/info', (_req, res) => {
  res.json({
    ...MCP_SERVER_CONFIG,
    capabilities: {
      supports_streaming: true,
      supports_progress: true,
      supports_cancellation: true,
      max_request_size: 10 * 1024 * 1024, // 10MB
      supported_content_types: [
        "application/json",
        "text/plain",
        "text/markdown",
        "text/html"
      ]
    },
    pricing: {
      free_tier: {
        monthly_searches: 1000,
        rate_limit: 100 // per hour
      },
      pro_tier: {
        monthly_searches: -1, // unlimited
        rate_limit: 1000 // per hour
      }
    }
  });
});

/**
 * MCP Tool Execution Endpoint
 */
mcpRouter.post('/tools/call', async (req, res, next) => {
  try {
    // 1. Validate MCP request format
    const mcpRequest = MCPRequestSchema.parse(req.body);
    
    // 2. Authenticate AI agent
    const authResult = await mcpAuth.authenticate(req);
    if (!authResult.success) {
      res.status(401).json({
        jsonrpc: "2.0",
        id: mcpRequest.id,
        error: {
          code: -32001,
          message: "Authentication failed",
          data: { reason: authResult.error }
        }
      });
      return;
    }

    const agent = authResult.agent;

    // 3. Check rate limits
    const rateLimitResult = await mcpRateLimit.checkLimit(agent, mcpRequest.params.tool);
    if (rateLimitResult.exceeded) {
      res.status(429).json({
        jsonrpc: "2.0",
        id: mcpRequest.id,
        error: {
          code: -32003,
          message: "Rate limit exceeded",
          data: {
            retry_after: rateLimitResult.retryAfter,
            limit: rateLimitResult.limit,
            remaining: rateLimitResult.remaining
          }
        }
      });
      return;
    }

    // 4. Validate tool exists
    if (!MCP_SERVER_CONFIG.tools.includes(mcpRequest.params.tool)) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: mcpRequest.id,
        error: {
          code: -32601,
          message: "Tool not found",
          data: {
            tool: mcpRequest.params.tool,
            available_tools: MCP_SERVER_CONFIG.tools
          }
        }
      });
      return;
    }

    // 5. Execute tool
    const startTime = Date.now();
    const result = await toolHandler.execute(
      mcpRequest.params.tool,
      mcpRequest.params.arguments,
      agent
    );
    const executionTime = Date.now() - startTime;

    // 6. Track analytics
    await mcpAnalytics.trackToolExecution({
      agent_id: agent.id,
      tool: mcpRequest.params.tool,
      execution_time_ms: executionTime,
      success: result.success,
      user_id: agent.user_id
    });

    // 7. Return MCP response
    if (result.success) {
      res.json({
        jsonrpc: "2.0",
        id: mcpRequest.id,
        result: {
          data: result.data,
          metadata: {
            execution_time_ms: executionTime,
            agent_tier: agent.tier,
            rate_limit_remaining: rateLimitResult.remaining
          }
        }
      });
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        id: mcpRequest.id,
        error: {
          code: -32602,
          message: result.error || "Tool execution failed",
          data: result.details
        }
      });
    }

  } catch (error) {
    logger.error('MCP tool execution error:', error);
    
    if (error instanceof z.ZodError) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: req.body?.id || "unknown",
        error: {
          code: -32600,
          message: "Invalid request format",
          data: { validation_errors: error.errors }
        }
      });
      return;
    }

    next(error);
  }
});

/**
 * MCP Streaming Endpoint for Large Results
 */
mcpRouter.post('/tools/stream', async (req, res) => {
  try {
    const mcpRequest = MCPRequestSchema.parse(req.body);

    // Set up Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Authenticate
    const authResult = await mcpAuth.authenticate(req);
    if (!authResult.success) {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: 'Authentication failed'
      })}\n\n`);
      res.end();
      return;
    }

    // Execute with streaming
    await toolHandler.executeStream(
      mcpRequest.params.tool,
      mcpRequest.params.arguments,
      authResult.agent,
      (chunk) => {
        res.write(`data: ${JSON.stringify({
          type: 'chunk',
          data: chunk
        })}\n\n`);
      }
    );

    res.write(`data: ${JSON.stringify({
      type: 'complete'
    })}\n\n`);
    res.end();

  } catch (error) {
    logger.error('MCP streaming error:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: errorMessage(error)
    })}\n\n`);
    res.end();
  }
});

/**
 * MCP Schema Endpoint - Returns tool schemas
 */
mcpRouter.get('/tools/schema', (_req, res) => {
  const schemas = {
    search_premium_content: {
      name: "search_premium_content",
      description: "Search for premium content across all platforms",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          categories: { type: "array", items: { type: "string" } },
          price_range: { 
            type: "object", 
            properties: {
              min: { type: "number" },
              max: { type: "number" }
            }
          },
          platforms: { type: "array", items: { type: "string" } },
          content_types: { type: "array", items: { type: "string" } },
          sort_by: { 
            type: "string", 
            enum: ["relevance", "price", "date", "quality", "popularity"] 
          },
          limit: { type: "number", minimum: 1, maximum: 100, default: 20 }
        },
        required: ["query"]
      }
    },
    get_content_metadata: {
      name: "get_content_metadata",
      description: "Get detailed metadata for specific content",
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Unique content identifier" },
          include_preview: { type: "boolean", default: true },
          include_analytics: { type: "boolean", default: false }
        },
        required: ["content_id"]
      }
    },
    purchase_content: {
      name: "purchase_content",
      description: "Purchase access to premium content",
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Content to purchase" },
          payment_method: { 
            type: "string", 
            enum: ["account_balance", "stripe", "crypto"],
            default: "account_balance"
          },
          note: { type: "string", description: "Optional purchase note" }
        },
        required: ["content_id"]
      }
    },
    get_content: {
      name: "get_content",
      description: "Access purchased content",
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Content identifier" },
          format: { 
            type: "string", 
            enum: ["text", "markdown", "html", "json"], 
            default: "text" 
          }
        },
        required: ["content_id"]
      }
    },
    track_usage: {
      name: "track_usage",
      description: "Track content usage and provide feedback",
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Content identifier" },
          usage_type: { 
            type: "string", 
            enum: ["view", "download", "process", "reference"] 
          },
          satisfaction: { 
            type: "number", 
            minimum: 1, 
            maximum: 5, 
            description: "Content quality rating" 
          },
          feedback: { type: "string", description: "Optional feedback" }
        },
        required: ["content_id", "usage_type"]
      }
    },
    manage_preferences: {
      name: "manage_preferences",
      description: "Manage AI agent preferences and learning",
      inputSchema: {
        type: "object",
        properties: {
          preferences: {
            type: "object",
            properties: {
              content_types: { type: "array", items: { type: "string" } },
              max_price_per_item: { type: "number" },
              preferred_platforms: { type: "array", items: { type: "string" } },
              quality_threshold: { type: "number", minimum: 1, maximum: 5 },
              auto_purchase_enabled: { type: "boolean" }
            }
          },
          learning_data: {
            type: "object",
            description: "Data to improve recommendations"
          }
        }
      }
    }
  };

  res.json({
    server: MCP_SERVER_CONFIG,
    tools: schemas
  });
});

/**
 * Health check for MCP server
 */
mcpRouter.get('/health', async (_req, res) => {
  try {
    // Check database connectivity
    const dbHealth = await toolHandler.healthCheck();
    
    res.json({
      status: 'healthy',
      version: MCP_SERVER_CONFIG.version,
      uptime: process.uptime(),
      services: {
        database: dbHealth.database ? 'healthy' : 'unhealthy',
        search: dbHealth.search ? 'healthy' : 'unhealthy',
        payments: dbHealth.payments ? 'healthy' : 'unhealthy'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('MCP health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: errorMessage(error),
      timestamp: new Date().toISOString()
    });
  }
});