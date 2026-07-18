/**
 * @bivelio/licensing-service
 * PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
 *
 * Control-plane licensing service core (issue / validate / revoke). The HTTP
 * server lives in ./server.ts; this module exports the transport-agnostic
 * service so it can be embedded or tested directly.
 */
export * from "./service.js";
export * from "./gateway.js";
