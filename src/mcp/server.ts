#!/usr/bin/env node
import './loadEnv.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCheckSession } from './tools/checkSession.js';
import { registerListInventory } from './tools/listInventory.js';
import { registerDownloadLabels } from './tools/downloadLabels.js';
import { registerPrintLabels } from './tools/printLabels.js';
import { registerDownloadShipmentLabels } from './tools/downloadShipmentLabels.js';
import { registerPrintShipmentLabels } from './tools/printShipmentLabels.js';
import { registerListPrinters } from './tools/listPrinters.js';

const server = new McpServer({ name: 'seller-central-label-printing', version: '0.1.0' });

registerCheckSession(server);
registerListInventory(server);
registerDownloadLabels(server);
registerPrintLabels(server);
registerDownloadShipmentLabels(server);
registerPrintShipmentLabels(server);
registerListPrinters(server);

await server.connect(new StdioServerTransport());
