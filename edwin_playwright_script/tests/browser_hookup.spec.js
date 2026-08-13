// @ts-check
import { test, chromium, expect } from '@playwright/test';

import fs from 'node:fs';
import path from 'node:path';

const mock_data = {   
    "sku": "RZ-NWIT-GMO4",
    "numLabels": 72
};

// @ts-ignore
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('Run tests inside active Brave browser instance', async () => {
    // 1. Connect to Brave via the open CDP port
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    
    // 2. Fetch the default authenticated context
    const defaultContext = browser.contexts()[0];
    
    // 3. Open a new tab in your existing session
    const acs_page = await defaultContext.newPage();

    // 4. Navigate directly to your dashboard (bypassing 2FA)
    await acs_page.goto('https://sellercentral.amazon.com/home');

    // Note: Avoid calling browser.close() so your Brave window stays open for the next test run
    await acs_page.locator('navigation-hamburger-menu').getByRole('button').filter({ hasText: /^$/ }).click();
    await acs_page.locator('#navbar').getByText('Inventory', { exact: true }).click();
    await acs_page.getByRole('link', { name: 'Manage All Inventory', exact: true }).click();

    /* We're at the inventory lookup page. */

    /* Extract a SKU and enter into search bar: For now we hardcode w/ mock data */
    await acs_page.getByRole('textbox', { name: 'Search SKU, Title/Keyword,' }).click();
    await acs_page.getByRole('textbox', { name: 'Search SKU, Title/Keyword,' }).fill(mock_data.sku);
    /* Sometimes search doesn't get hit? 1 sec delay is not a good fix. */
    await delay(1000);
    await acs_page.getByRole('textbox', { name: 'Search SKU, Title/Keyword,' }).press('Enter');

    /* Expect the listing to be visible: should be one entry only. */
    await expect(acs_page.locator(`#${mock_data.sku}`).getByRole('button', { name: 'open dropdown' })).toBeVisible();
    await acs_page.locator(`#${mock_data.sku}`).getByRole('button', { name: 'open dropdown' }).click();
    const print_label_page_Promise = acs_page.waitForEvent('popup');
    await acs_page.getByRole('menuitem', { name: 'Print item labels' }).click();
    const print_label_page = await print_label_page_Promise;

    /* Ensure correct print format */
    await print_label_page.getByTitle('Standard formats').click();
    await print_label_page.getByRole('listbox').getByText('Standard formats').click();
    await print_label_page.locator('#katal-id-2').click();
    await print_label_page.getByRole('listbox').getByText('30-up labels 1" x 2 5/8" on').click();
    
    /* Select n number of labels */
    await print_label_page.locator('#katal-id-0').click();
    await print_label_page.locator('#katal-id-0').press('ControlOrMeta+a');
    await print_label_page.locator('#katal-id-0').fill('');
    await print_label_page.locator('#katal-id-0').fill(`${mock_data.numLabels}`); /* put numLabels here */

    /*
    let print_label_page_Promise = acs_page.waitForEvent('popup');
    await acs_page.getByRole('menuitem', { name: 'Print item labels' }).click();
    */
    print_label_page.once('dialog', dialog => {
        console.log(`Dialog message: ${dialog.message()}`);
        dialog.accept().catch(() => {});
    });

    const downloadPromise = print_label_page.waitForEvent('download');
    await print_label_page.getByRole('button', { name: 'Print Item Labels' }).click();
    const download = await downloadPromise;

    /* Prevent overwriting files with the same suggested name. */
    let suggestedName = download.suggestedFilename();
    let counter = 1;
    const parsed = path.parse(suggestedName);
    let filePath = path.join(__dirname, "..", "outputs", suggestedName);
    while (fs.existsSync(filePath)) {
        const newName = `${parsed.name}-${counter}${parsed.ext}`;
        filePath = path.join(__dirname, "..", "outputs", newName);
        counter++;
    }

    // Wait for the download process to complete and save the downloaded file
    await download.saveAs(filePath);

    /* Use this as a breakpoint */
    // await print_label_page.pause();
});
