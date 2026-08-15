#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from './config.js';
import { login } from './auth.js';
import { launchSession } from './browser.js';
import { InventoryPage } from './pages/inventoryPage.js';
import { printLabels } from './tasks/printLabels.js';
import { printShipmentLabels, readShipmentItems } from './tasks/shipmentLabels.js';
import { listPrinters } from './printer.js';
import { log } from './logger.js';
import type { LabelFormat, LabelRequest, LabelResult } from './types.js';

const USAGE = `
Seller Central label printing

  npm run login                         Sign in once; saves the browser session
  npm run print -- --sku ABC-123 --qty 30
  npm run print -- --file data/products.json --dry-run
  npm run print -- --shipment <wf-id>   Label a whole Send to Amazon shipment
  npm run shipment -- --shipment <wf-id>  Show a shipment's SKUs, print nothing
  npm run list  -- --search "coffee"    Show matching inventory rows

Options
  --sku <sku>          SKU to label (repeatable)
  --qty <n>            Labels per SKU (default 1; pairs with the preceding --sku)
  --file <path>        JSON array of { sku, quantity, format?, title? }
  --shipment <wf>      Send to Amazon workflow id, or its confirm_content_step
                       URL. Labels every ready-to-send SKU, one label per unit.
  --format <fmt>       ${'Override label layout, e.g. ItemLabel_Letter_30, thermal'}
  --dry-run            Download the PDFs, never send to the printer
  --headed             Force a visible browser window
  --json               Print machine-readable results (for skill use)
  --printers           List available printers and exit
  --help
`;

interface Args {
  command: string;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  // A leading flag (`--help`, `--printers`) means no command was given.
  const hasCommand = argv[0] !== undefined && !argv[0].startsWith('--');
  const command = hasCommand ? argv[0]! : 'help';
  const rest = hasCommand ? argv.slice(1) : argv;
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    const value = next && !next.startsWith('--') ? (i++, next) : 'true';
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { command, flags };
}

/** Pair up repeated --sku/--qty flags positionally: --sku A --qty 5 --sku B --qty 2 */
function requestsFromFlags(flags: Map<string, string[]>): LabelRequest[] {
  const skus = flags.get('sku') ?? [];
  const qtys = flags.get('qty') ?? [];
  const format = flags.get('format')?.[0] as LabelFormat | undefined;

  return skus.map((sku, i) => ({
    sku,
    quantity: Number.parseInt(qtys[i] ?? qtys[0] ?? '1', 10) || 1,
    ...(format ? { format } : {}),
  }));
}

async function requestsFromFile(path: string): Promise<LabelRequest[]> {
  const raw = await readFile(resolve(config.root, path), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array of label requests.`);

  return parsed.map((entry, i) => {
    const item = entry as Partial<LabelRequest>;
    if (!item.sku) throw new Error(`${path}[${i}] is missing "sku".`);
    return { ...item, sku: item.sku, quantity: Number(item.quantity ?? 1) } as LabelRequest;
  });
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.has('printers')) {
    const printers = await listPrinters();
    console.log(printers.length ? printers.join('\n') : 'No printers found.');
    return 0;
  }

  if (flags.has('help') || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case 'login': {
      await login();
      return 0;
    }

    case 'print': {
      const file = flags.get('file')?.[0];
      const shipment = flags.get('shipment')?.[0];
      const format = flags.get('format')?.[0] as LabelFormat | undefined;
      const printOptions = { dryRun: flags.has('dry-run'), headed: flags.has('headed') };

      let results: LabelResult[];
      if (shipment) {
        // Reads the shipment and prints in one browser session — see
        // printShipmentLabels() for why that matters (it used to be two
        // separate launches).
        results = await printShipmentLabels(shipment, { ...printOptions, ...(format ? { format } : {}) });
      } else {
        const requests = file ? await requestsFromFile(file) : requestsFromFlags(flags);
        if (requests.length === 0) {
          log.error('Nothing to print. Pass --sku/--qty, --file, or --shipment.');
          console.log(USAGE);
          return 1;
        }
        results = await printLabels(requests, printOptions);
      }

      if (flags.has('json')) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const r of results) log.info(`${r.sku}: ${r.status}${r.message ? ` — ${r.message}` : ''}`);
      }
      return results.some((r) => r.status === 'failed' || r.status === 'print-failed') ? 1 : 0;
    }

    case 'shipment': {
      const shipment = flags.get('shipment')?.[0] ?? flags.get('wf')?.[0];
      if (!shipment) {
        log.error('Pass --shipment <workflow-id or confirm_content_step URL>.');
        console.log(USAGE);
        return 1;
      }

      const items = await readShipmentItems(shipment, { headed: flags.has('headed') });
      if (flags.has('json')) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        for (const i of items) {
          console.log(`${i.sku.padEnd(24)} ${String(i.units).padStart(6)} units${i.boxes ? `  (${i.boxes} boxes)` : ''}`);
        }
        console.log(`\n${items.length} SKUs, ${items.reduce((s, i) => s + i.units, 0)} units total.`);
      }
      return 0;
    }

    case 'list': {
      const query = flags.get('search')?.[0] ?? '';
      const session = await launchSession({ headed: flags.has('headed') });
      try {
        const inventory = new InventoryPage(session.page);
        await inventory.open();
        if (query) await inventory.search(query);
        const items = await inventory.listVisible();
        console.log(flags.has('json') ? JSON.stringify(items, null, 2) : formatTable(items));
      } finally {
        await session.close({ save: true });
      }
      return 0;
    }

    default:
      log.error(`Unknown command: ${command}`);
      console.log(USAGE);
      return 1;
  }
}

function formatTable(items: { sku: string; title?: string; available?: string }[]): string {
  if (items.length === 0) return 'No rows matched.';
  return items.map((i) => `${i.sku.padEnd(24)} ${(i.title ?? '').slice(0, 60).padEnd(60)} ${i.available ?? ''}`).join('\n');
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
