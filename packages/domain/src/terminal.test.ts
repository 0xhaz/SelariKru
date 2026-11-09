import { describe, expect, it } from 'vitest';
import { sanitizeTerminalText } from './terminal.ts';

describe('sanitizeTerminalText', () => {
  it('removes ANSI colour, cursor and OSC sequences rather than interpreting them', () => {
    expect(sanitizeTerminalText('\u001b[31mred\u001b[0m')).toBe('red');
    expect(sanitizeTerminalText('\u001b[2K\u001b[1Gdone')).toBe('done');
    expect(sanitizeTerminalText('\u001b]0;title\u0007body')).toBe('body');
    expect(sanitizeTerminalText('\u001b]8;;http://evil\u001b\\link')).toBe('link');
  });

  it('removes C0 and C1 control characters, keeping tab and newline', () => {
    expect(sanitizeTerminalText('a\u0000b\u0008c\tb\nc\u009dd')).toBe('abc\tb\ncd');
  });

  it('removes the combining grapheme joiner, variation selectors and blank fillers', () => {
    const invisible = [0x34f, 0xfe00, 0xfe0f, 0x3164, 0xffa0, 0xe0100].map((c) => String.fromCodePoint(c));
    for (const c of invisible) expect(sanitizeTerminalText(`a${c}b`)).toBe('ab');
  });

  it('removes bidi and zero-width characters, including those that would hide a token', () => {
    expect(sanitizeTerminalText('a‮b⁦c​d‍e﻿ f')).toBe('abcdef');
    expect(sanitizeTerminalText('sk-ant-​AAAA‭BBBB')).toBe('sk-ant-AAAABBBB');
  });
});
