import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { redisClient } from "../../shared/redis.js";
import { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../../shared/logger.js";

let redisTransportCounter = 0;
const notificationStreamId = "__GET_stream";

// Message types for Redis transport
type RedisMessage = 
  | {
      type: 'mcp';
      message: JSONRPCMessage;
      extra?: MessageExtraInfo;
      options?: TransportSendOptions;
    }
  | {
      type: 'control';
      action: 'SHUTDOWN' | 'PING' | 'STATUS';
      timestamp?: number;
    };

function sendToMcpServer(sessionId: string, message: JSONRPCMessage, extra?: { authInfo?: AuthInfo; }, options?: TransportSendOptions): Promise<void> {
  const toServerChannel = getToServerChannel(sessionId);
  
  logger.debug('Sending message to MCP server via Redis', {
    sessionId,
    channel: toServerChannel,
    method: ('method' in message ? message.method : undefined),
    id: ('id' in message ? message.id : undefined)
  });
  
  const redisMessage: RedisMessage = { type: 'mcp', message, extra, options };
  return redisClient.publish(toServerChannel, JSON.stringify(redisMessage));
}

function getToServerChannel(sessionId: string): string {
  return `mcp:shttp:toserver:${sessionId}`;
}

function getToClientChannel(sessionId: string, relatedRequestId: string): string {
  return `mcp:shttp:toclient:${sessionId}:${relatedRequestId}`;
}

function getControlChannel(sessionId: string): string {
  return `mcp:control:${sessionId}`;
}

function sendControlMessage(sessionId: string, action: 'SHUTDOWN' | 'PING' | 'STATUS'): Promise<void> {
  const controlChannel = getControlChannel(sessionId);
  const redisMessage: RedisMessage = {
    type: 'control',
    action,
    timestamp: Date.now()
  };
  return redisClient.publish(controlChannel, JSON.stringify(redisMessage));
}

export async function shutdownSession(sessionId: string): Promise<void> {
  logger.info('Sending shutdown control message', { sessionId });
  return sendControlMessage(sessionId, 'SHUTDOWN');
}

export async function isLive(sessionId: string): Promise<boolean> {
  // Check if the session is live by checking if the key exists in Redis
  const numSubs = await redisClient.numsub(getToServerChannel(sessionId));
  return numSubs > 0;
}

const SESSION_OWNER_TTL_SEC = 25 * 60 * 60; // 25 hours — slightly longer than the 24h inactivity timeout so the key outlives the session

export async function setSessionOwner(sessionId: string, userId: string): Promise<void> {
  logger.debug('Setting session owner', { sessionId, userId });
  await redisClient.set(`session:${sessionId}:owner`, userId, { EX: SESSION_OWNER_TTL_SEC });
}

export async function getSessionOwner(sessionId: string): Promise<string | null> {
  return await redisClient.get(`session:${sessionId}:owner`);
}

export async function validateSessionOwnership(sessionId: string, userId: string): Promise<boolean> {
  const owner = await getSessionOwner(sessionId);
  return owner === userId;
}

export async function isSessionOwnedBy(sessionId: string, userId: string): Promise<boolean> {
  const isLiveSession = await isLive(sessionId);
  if (!isLiveSession) {
    logger.debug('Session not live', { sessionId });
    return false;
  }
  const isOwned = await validateSessionOwnership(sessionId, userId);
  logger.debug('Session ownership check', { sessionId, userId, isOwned });
  return isOwned;
}


export async function redisRelayToMcpServer(sessionId: string, transport: Transport, isGetRequest: boolean = false): Promise<() => Promise<void>> {
  logger.debug('Setting up Redis relay to MCP server', {
    sessionId,
    isGetRequest
  });
  
  let redisCleanup: (() => Promise<void>) | undefined = undefined;
  const cleanup = async () => {
    // TODO: solve race conditions where we call cleanup while the subscription is being created / before it is created
    if (redisCleanup) {
      logger.debug('Cleaning up Redis relay', { sessionId });
      await redisCleanup();
    }
  }

  const subscribe = async (requestId: string) => {
    const toClientChannel = getToClientChannel(sessionId, requestId);
    
    logger.debug('Subscribing to client channel', {
      sessionId,
      requestId,
      channel: toClientChannel
    });

    redisCleanup = await redisClient.createSubscription(toClientChannel, async (redisMessageJson) => {
      const redisMessage = JSON.parse(redisMessageJson) as RedisMessage;
      if (redisMessage.type === 'mcp') {
        logger.debug('Relaying message from Redis to client', {
          sessionId,
          requestId,
          method: ('method' in redisMessage.message ? redisMessage.message.method : undefined)
        });
        try {
          await transport.send(redisMessage.message, redisMessage.options);
        } catch (sendError) {
          logger.debug('Client connection closed before relay could deliver', {
            sessionId,
            requestId,
            error: (sendError as Error).message,
          });
        }
      }
    }, (error) => {
      logger.error('Error in Redis relay subscription', error, {
        sessionId,
        channel: toClientChannel
      });
      transport.onerror?.(error);
    });
  }

  if (isGetRequest) {
    await subscribe(notificationStreamId);
  } else {
    const messagePromise = new Promise<JSONRPCMessage>((resolve) => {
      transport.onmessage = async (message, extra) => {
        // First, set up response subscription if needed
        if ("id" in message) {
          logger.debug('Setting up response subscription', {
            sessionId,
            messageId: message.id,
            method: ('method' in message ? message.method : undefined)
          });
          await subscribe(message.id.toString());
        }
        // Now send the message to the MCP server
        await sendToMcpServer(sessionId, message, extra);
        resolve(message);
      }
    });
  
    messagePromise.catch((error) => {
      transport.onerror?.(error);
      cleanup();
    });   
  }
  return cleanup;
}


// New Redis transport for server->client messages using request-id based channels
export class ServerRedisTransport implements Transport {
  private counter: number;
  private _sessionId: string;
  private controlCleanup?: (() => Promise<void>);
  private serverCleanup?: (() => Promise<void>);
  private shouldShutdown = false;
  private inactivityTimeout?: NodeJS.Timeout;
  private readonly INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours — matches ACCESS_TOKEN_EXPIRY_SEC so sessions live until the token expires

  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage, extra?: { authInfo?: AuthInfo; }) => void) | undefined;

  constructor(sessionId: string) {
    this.counter = redisTransportCounter++;
    this._sessionId = sessionId;
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    // Keep the session owner key alive while the session is active
    void redisClient.expire(`session:${this._sessionId}:owner`, SESSION_OWNER_TTL_SEC);

    this.inactivityTimeout = setTimeout(() => {
      logger.info('Session timed out due to inactivity', {
        sessionId: this._sessionId,
        timeoutMs: this.INACTIVITY_TIMEOUT_MS
      });
      void shutdownSession(this._sessionId);
    }, this.INACTIVITY_TIMEOUT_MS);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = undefined;
    }
  }

  async start(): Promise<void> {
    logger.info('Starting ServerRedisTransport', {
      sessionId: this._sessionId,
      inactivityTimeoutMs: this.INACTIVITY_TIMEOUT_MS
    });
    
    // Start inactivity timer
    this.resetInactivityTimer();
    
    // Subscribe to MCP messages from clients
    const serverChannel = getToServerChannel(this._sessionId);
    logger.debug('Subscribing to server channel', {
      sessionId: this._sessionId,
      channel: serverChannel
    });
    
    this.serverCleanup = await redisClient.createSubscription(
      serverChannel,
      (messageJson) => {
        const redisMessage = JSON.parse(messageJson) as RedisMessage;
        if (redisMessage.type === 'mcp') {
          // Reset inactivity timer on each message from client
          this.resetInactivityTimer();
          
          logger.debug('Received MCP message from client', {
            sessionId: this._sessionId,
            method: ('method' in redisMessage.message ? redisMessage.message.method : undefined),
            id: ('id' in redisMessage.message ? redisMessage.message.id : undefined)
          });
          
          this.onmessage?.(redisMessage.message, redisMessage.extra);
        }
      },
      (error) => {
        logger.error('Error in server channel subscription', error, {
          sessionId: this._sessionId,
          channel: serverChannel
        });
        this.onerror?.(error);
      }
    );
    
    // Subscribe to control messages for shutdown
    const controlChannel = getControlChannel(this._sessionId);
    logger.debug('Subscribing to control channel', {
      sessionId: this._sessionId,
      channel: controlChannel
    });
    
    this.controlCleanup = await redisClient.createSubscription(
      controlChannel,
      (messageJson) => {
        const redisMessage = JSON.parse(messageJson) as RedisMessage;
        if (redisMessage.type === 'control') {
          logger.info('Received control message', {
            sessionId: this._sessionId,
            action: redisMessage.action
          });
          
          if (redisMessage.action === 'SHUTDOWN') {
            logger.info('Shutting down transport due to control message', {
              sessionId: this._sessionId
            });
            this.shouldShutdown = true;
            this.close();
          }
        }
      },
      (error) => {
        logger.error('Error in control channel subscription', error, {
          sessionId: this._sessionId,
          channel: controlChannel
        });
        this.onerror?.(error);
      }
    );
    
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const relatedRequestId = options?.relatedRequestId?.toString() ?? ("id" in message ? message.id?.toString() : notificationStreamId);
    const channel = getToClientChannel(this._sessionId, relatedRequestId)

    logger.debug('Sending message to client', {
      sessionId: this._sessionId,
      channel,
      method: ('method' in message ? message.method : undefined),
      id: ('id' in message ? message.id : undefined),
      relatedRequestId
    });

    const redisMessage: RedisMessage = { type: 'mcp', message, options };
    const messageStr = JSON.stringify(redisMessage);
    await redisClient.publish(channel, messageStr);
  }

  async close(): Promise<void> {
    logger.info('Closing ServerRedisTransport', {
      sessionId: this._sessionId,
      wasShutdown: this.shouldShutdown
    });
    
    // Clear inactivity timer
    this.clearInactivityTimer();
    
    // Clean up server message subscription
    if (this.serverCleanup) {
      await this.serverCleanup();
      this.serverCleanup = undefined;
    }
    
    // Clean up control message subscription
    if (this.controlCleanup) {
      await this.controlCleanup();
      this.controlCleanup = undefined;
    }
    
    this.onclose?.();
  }
}

export async function getShttpTransport(sessionId: string, onsessionclosed: (sessionId: string) => void | Promise<void>, isGetRequest: boolean = false): Promise<StreamableHTTPServerTransport> {
  logger.debug('Getting StreamableHTTPServerTransport for existing session', {
    sessionId,
    isGetRequest
  });
  
  // Giving undefined here and setting the sessionId means the 
  // transport wont try to create a new session.
  const shttpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    onsessionclosed,
  })
  shttpTransport.sessionId = sessionId;

  // Use the new request-id based relay approach
  const cleanup = await redisRelayToMcpServer(sessionId, shttpTransport, isGetRequest);
  shttpTransport.onclose = cleanup; 
  return shttpTransport;
}