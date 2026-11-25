import { describe, it, expect } from 'vitest';
import {
  parseQuestions, planQuestions, questionsText, QUESTIONS_DEFAULT, QUESTIONS_TEXT_MAX, QUESTIONS_MAX_ASKED,
} from '../../models && skills/core/questions.js';
import { ZIP_FOLDERS } from '../../models && skills/core/zip-halt.js';
import { ALL_PORTS, QUESTION_PORT, portByNumber } from '../../models && skills/core/ports.js';

describe('questions (how often the AI asks when it is not sure)', () => {
  it('reads a dial value and ignores anything else', () => {
    expect(parseQuestions(30)).toBe(30);
    expect(parseQuestions('80')).toBe(80);
    expect(parseQuestions(-5)).toBe(0);
    expect(parseQuestions(250)).toBe(100);
    for (const bad of [undefined, null, '', 'often', NaN, Infinity, true, {}, []]) expect(parseQuestions(bad)).toBeNull();
  });

  it('asks more readily as the dial rises, and never at the bottom', () => {
    const levels = [0, 14, 15, 30, 50, 70, 90, 100];
    const max = levels.map(v => planQuestions(v).maxQuestions);
    expect(max[0]).toBe(0);
    expect(max[1]).toBe(0);
    for (let i = 1; i < max.length; i++) expect(max[i]).toBeGreaterThanOrEqual(max[i - 1]);
    expect(planQuestions(100).maxQuestions).toBe(QUESTIONS_MAX_ASKED);
    expect(planQuestions(15).maxQuestions).toBe(1);
    expect(planQuestions(undefined).level).toBe(QUESTIONS_DEFAULT);
    expect(planQuestions(0).mode).toBe('never');
    expect(planQuestions(89).mode).toBe('often');
    expect(planQuestions(90).mode).toBe('always');
  });

  it('asks when it is less sure than the dial says', () => {
    expect(planQuestions(70).askBelow).toBe(70);
    expect(questionsText(70)).toMatch(/less than 70% sure/);
  });

  it('sends nothing when unset or at the default', () => {
    expect(questionsText(undefined)).toBeNull();
    expect(questionsText('junk')).toBeNull();
    expect(questionsText(QUESTIONS_DEFAULT)).toBeNull();
  });

  it('says never ask at the bottom, any doubt at the top, and that it decides on asking', () => {
    expect(questionsText(0)).toMatch(/Never ask/);
    expect(questionsText(10)).toMatch(/Never ask/);
    expect(questionsText(100)).toMatch(/any doubt/);
    for (const v of [0, 20, 80, 100]) expect(questionsText(v)).toMatch(/decides whether to ask/);
    for (let v = 0; v <= 100; v++) { const t = questionsText(v); if (t) expect(t.length).toBeLessThanOrEqual(QUESTIONS_TEXT_MAX); }
  });

  it('has its own folder and its own port, distinct from every other', () => {
    expect(ZIP_FOLDERS.questions).toBe('questions/');
    expect(Object.values(ZIP_FOLDERS)).toHaveLength(new Set(Object.values(ZIP_FOLDERS)).size);
    expect(QUESTION_PORT).toBe(9);
    expect(portByNumber(QUESTION_PORT)?.folder).toBe(ZIP_FOLDERS.questions);
    expect(new Set(ALL_PORTS.map(p => p.port)).size).toBe(ALL_PORTS.length);
  });
});
