import { readDate } from './dates';

describe('readDate', () => {
  it.each([
    ['2019', { kind: 'date', value: '2019', precision: 'year' }],
    ['Mar 2020', { kind: 'date', value: '2020-03', precision: 'month' }],
    ['March 2020', { kind: 'date', value: '2020-03', precision: 'month' }],
    ['Sept. 2021', { kind: 'date', value: '2021-09', precision: 'month' }],
    ['03/2020', { kind: 'date', value: '2020-03', precision: 'month' }],
    ['2020-03', { kind: 'date', value: '2020-03', precision: 'month' }],
    ['2020-03-15', { kind: 'date', value: '2020-03-15', precision: 'day' }],
    ['15 March 2020', { kind: 'date', value: '2020-03-15', precision: 'day' }],
    ['March 15, 2020', { kind: 'date', value: '2020-03-15', precision: 'day' }],
    ['Summer 2018', { kind: 'date', value: '2018', precision: 'year' }],
    ['Present', { kind: 'present' }],
    ['current', { kind: 'present' }],
  ])('reads %s at the precision it states', (text, expected) => {
    expect(readDate(text)).toEqual(expected);
  });

  it.each([
    // Day-first and month-first numeric dates cannot be told apart.
    '03/04/2020',
    "Mar '20",
    '2020-13',
    '2023-02-29',
    'Smarch 2020',
    'recently',
    '1850',
    'Summer',
  ])('refuses to guess %s', (text) => {
    expect(readDate(text)).toEqual({ kind: 'unknown' });
  });

  it('reads nothing from null', () => {
    expect(readDate(null)).toEqual({ kind: 'unknown' });
  });
});
