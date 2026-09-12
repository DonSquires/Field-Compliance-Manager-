import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const oracle = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/conductor-oracle.ts'), 'utf8');
const conductor = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');

describe('Bob Oracle architecture', () => {
  it('keeps Oracle descriptive and non-selecting', () => {
    expect(oracle).toContain('Oracle describes the turn and candidate effect; it never selects or permits.');
    expect(oracle).toContain('buildOracleTurnTruthState');
    expect(oracle).not.toContain('isToolEffectPermitted');
    expect(oracle).not.toContain('chosenTool');
  });

  it('gives Bob the catalogue and enforces the selected effect after reasoning', () => {
    expect(conductor).toContain('Ask Bob\'s BRAIN (the model tool-planner) what to do');
    expect(conductor).toContain('generateToolCatalogue');
    expect(conductor).toContain('if (chosenTool && !isToolEffectPermitted(chosenTool, caps))');
    expect(conductor).toContain('if (!isToolEffectPermitted(next.chosenTool, caps))');
    expect(caddie).toContain('classifyToolEffect');
    expect(caddie).toContain('isToolEffectPermitted');
  });

  it('keeps the planner optional rather than forcing a fixed tool sequence', () => {
    expect(conductor).toContain('the model decides which tool to run');
    expect(conductor).toContain('There is no keyword TOOL router');
    expect(conductor).toContain('BOB_LOOP_ENABLED');
  });
});
