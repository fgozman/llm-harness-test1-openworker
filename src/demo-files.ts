// The demo directory and the ten sample files the agent organizes.
//
// The file names are deliberately vague, so the agent has to read each file
// to decide where it belongs.
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DemoPaths } from './config.ts';

export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  'notes-0412.txt': `Weekly sync - April 12
Attendees: Priya, Marco, Dana
- Marco to finish the onboarding redesign by Friday
- Dana flagged the Q2 budget review is slipping
Next meeting: April 19, 10:00`,

  'untitled-1.txt': `Grandma's banana bread
3 ripe bananas, 1/3 cup melted butter, 3/4 cup sugar, 1 egg,
1 tsp baking soda, pinch of salt, 1.5 cups flour.
Bake at 350F for 60 minutes.`,

  'scan_8831.txt': `INVOICE #8831
Acme Office Supplies
2x ergonomic chair  ........ $420.00
1x standing desk    ........ $560.00
TOTAL DUE: $980.00   Due date: 2024-05-01`,

  'draft.txt': `Lisbon trip itinerary
Day 1: arrive LIS 09:40, check in at Alfama guesthouse
Day 2: Belem tower, pasteis de nata, LX Factory
Day 3: day trip to Sintra (train from Rossio)`,

  'misc-a.txt': `Standup notes 2024-04-15
Blockers: CI pipeline flaky on integration tests.
Action items: Priya to pair with Marco on the auth refactor.`,

  'todo-old.txt': `Weeknight chili
1 lb ground beef, 1 onion, 2 cans kidney beans, 1 can tomatoes,
2 tbsp chili powder, cumin. Simmer 45 min. Serves 4.`,

  'doc_77.txt': `Receipt - Blue Bottle Coffee
1 latte $5.50, 1 croissant $4.25
Subtotal $9.75  Tax $0.85  Total $10.60
Paid: VISA ****4421`,

  'file (2).txt': `Packing list for Tokyo
- passport, JR pass voucher, power adapter (Type A)
- hotel: Shinjuku, booking ref KX7712
Flight NH 7 departs SFO 11:15`,

  'temp.txt': `Retro - Sprint 14
What went well: shipped search filters on time.
What to improve: too many meetings; code reviews took 2+ days.
Decision: try async standups for two weeks.`,

  'new text document.txt': `Utility bill - City Power & Light
Account 55-2093-11, billing period March 2024
Amount due: $87.34 by April 20, 2024`,
};

/**
 * Deletes the previous demo (only if this app created it) and writes fresh
 * sample files into `paths.workspace`. Returns the sample file names.
 */
export async function resetDemoDirectory(
  paths: DemoPaths,
  files: Readonly<Record<string, string>> = SAMPLE_FILES,
): Promise<string[]> {
  if (existsSync(paths.root)) {
    // Never delete a directory this app didn't create.
    if (!existsSync(paths.marker)) {
      throw Error(`${paths.root} exists but was not created by this demo; refusing to reset it`);
    }
    await rm(paths.root, { recursive: true, force: true });
  }

  await mkdir(paths.workspace, { recursive: true });
  await writeFile(paths.marker, 'Created by organizer.ts; safe to delete.\n');

  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(paths.workspace, name), text + '\n', { flag: 'wx' }); // wx: never overwrite
  }
  return Object.keys(files);
}
