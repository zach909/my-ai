/**
 * Pages that refresh on a timer must stop while their tab is hidden and catch up when it
 * returns: a hidden tab polling keeps a phone's radio and CPU awake for a page nobody is
 * looking at (see commons-poll-visibility.test.ts, which pins the same rule for Commons).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SHARING_PAGE } from '../../interface/sharing-page.js';

const read = (p: string): string => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

function expectVisibilityAwarePoll(page: string): void {
  expect(page).toContain("'visibilitychange'");
  expect(page).toContain('document.hidden');
  expect(page).toContain('clearInterval');
}

describe('timer-driven pages pause while hidden', () => {
  it('the sharing page does not start its refresh timer unconditionally', () => {
    expectVisibilityAwarePoll(SHARING_PAGE);
    expect(SHARING_PAGE).not.toMatch(/^\s*setInterval\(refresh/m);
    expect(SHARING_PAGE).toContain('refresh(); startRefreshing();');
  });

  it('the stand-alone status page polls only while visible', () => {
    const page = read('interface/index.html');
    expectVisibilityAwarePoll(page);
    expect(page).not.toContain('checkStatus(); setInterval(checkStatus, 8000);');
  });

  it('the app launcher page polls only while visible', () => {
    const page = read('interface/app-launcher.html');
    expectVisibilityAwarePoll(page);
    expect(page).not.toMatch(/^\s*setInterval\(updateStatus/m);
    expect(page).toContain('updateStatus(); startStatusPolling();');
  });
});
