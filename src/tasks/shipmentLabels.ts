import { launchSession } from '../browser.js';
import { ShipmentPage, parseWorkflowId } from '../pages/shipmentPage.js';
import { printLabels, type PrintOptions } from './printLabels.js';
import { log } from '../logger.js';
import type { LabelFormat, LabelRequest, LabelResult, ShipmentItem } from '../types.js';

export interface ShipmentLookupOptions {
  /** Force a visible browser window. */
  headed?: boolean;
  /** Applied to every resulting LabelRequest. */
  format?: LabelFormat;
}

/** Scrape a shipment's SKUs and unit counts without printing anything. */
export async function readShipmentItems(
  workflowInput: string,
  options: ShipmentLookupOptions = {},
): Promise<ShipmentItem[]> {
  const workflowId = parseWorkflowId(workflowInput);
  const session = await launchSession({ headed: options.headed });

  try {
    log.step(`Reading shipment workflow ${workflowId}… (this page is slow to load)`);
    const shipment = new ShipmentPage(session.page);
    await shipment.open(workflowId);

    const items = await shipment.readyToSendItems();
    const totalUnits = items.reduce((sum, i) => sum + i.units, 0);
    log.done(`Shipment has ${items.length} SKUs, ${totalUnits} units total.`);
    return items;
  } finally {
    await session.close({ save: true });
  }
}

function itemsToRequests(items: ShipmentItem[], format?: LabelFormat): LabelRequest[] {
  return items.map((item) => ({
    sku: item.sku,
    quantity: item.units,
    ...(format ? { format } : {}),
  }));
}

/**
 * Read a shipment's contents and print one label per unit, in a single
 * browser session — reading the shipment and printing its labels are two
 * separate Seller Central pages, but there's no reason to pay for two full
 * browser launches (and two logins-worth of navigation) to do both.
 */
export async function printShipmentLabels(
  workflowInput: string,
  options: ShipmentLookupOptions & PrintOptions = {},
): Promise<LabelResult[]> {
  const workflowId = parseWorkflowId(workflowInput);
  const session = await launchSession({ headed: options.headed });

  try {
    log.step(`Reading shipment workflow ${workflowId}… (this page is slow to load)`);
    const shipment = new ShipmentPage(session.page);
    await shipment.open(workflowId);

    const items = await shipment.readyToSendItems();
    const totalUnits = items.reduce((sum, i) => sum + i.units, 0);
    log.done(`Shipment has ${items.length} SKUs, ${totalUnits} units total.`);

    const requests = itemsToRequests(items, options.format);
    return await printLabels(requests, { ...options, session });
  } finally {
    await session.close({ save: true });
  }
}
