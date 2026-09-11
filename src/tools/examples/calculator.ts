import { defineTool } from '../tool.js';

const ALLOWED_EXPRESSION = /^[\d\s+\-*/().%]+$/;

export const calculator = defineTool<{ expression: string }>({
  name: 'calculator',
  description:
    'Evaluate a basic arithmetic expression. Supports numbers, + - * / % and parentheses.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Arithmetic expression, for example "(3 + 5) * 2"',
      },
    },
    required: ['expression'],
  },
  execute({ expression }) {
    if (typeof expression !== 'string' || !ALLOWED_EXPRESSION.test(expression)) {
      throw new Error('expression may only contain digits, whitespace and + - * / % ( ) .');
    }
    const value: unknown = Function(`"use strict"; return (${expression});`)();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('expression did not evaluate to a finite number');
    }
    return String(value);
  },
});
