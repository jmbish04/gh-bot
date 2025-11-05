// Quick type fixes for deployment
// Run this with: deno run --allow-read --allow-write fix_types.ts

import { readFileSync, writeFileSync } from 'fs';

const filePath = './src/do_pr_workflows.ts';
let content = readFileSync(filePath, 'utf8');

// Fix 1: Add non-null assertion for installationId after validation
content = content.replace(
  /const token = await getInstallationToken\(this\.env, installationId\);/g,
  'const token = await getInstallationToken(this.env, installationId!);'
);

// Fix 2: Replace any types with proper types
content = content.replace(
  /evt\.triggers\.map\(\(t: any\) => String\(t\)\.toLowerCase\(\)\)/g,
  'evt.triggers.map((t: string) => String(t).toLowerCase())'
);

content = content.replace(
  /triggers\.filter\(\(t: any\) =>/g,
  'triggers.filter((t: string) =>'
);

content = content.replace(
  /triggers\.some\(\(t: any\) =>/g,
  'triggers.some((t: string) =>'
);

// Fix 3: Handle undefined deliveryId
content = content.replace(
  /deliveryId: evt\.delivery,/g,
  'deliveryId: evt.delivery || "",'
);

// Fix 4: Fix error types
content = content.replace(
  /\} catch \(err: any\) \{/g,
  '} catch (err: unknown) {'
);

content = content.replace(
  /\} catch \(error: any\) \{/g,
  '} catch (error: unknown) {'
);

// Fix 5: Type the response variable
content = content.replace(
  /let response;/g,
  'let response: any;'
);

// Fix 6: Fix as any casts
content = content.replace(
  /\(pr as any\)\?\.title/g,
  '(pr as { title?: string })?.title'
);

content = content.replace(
  /\(pr as any\)\?\.body/g,
  '(pr as { body?: string })?.body'
);

writeFileSync(filePath, content);
console.log('✅ Type fixes applied to do_pr_workflows.ts');
