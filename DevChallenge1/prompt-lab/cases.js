// Manual test cases from the project's design brief, pinned to one date so runs are comparable.
// expectDeadlines: goal deadlines a good answer should produce, in any goal order
// (null = the person gave no deadline).

export const TODAY = '2026-10-02'; // Friday
export const MAX_MINUTES = 25;

export const CASES = [
  {
    name: 'Huge vague goal',
    brainDump: 'get my life together',
    expectDeadlines: [null],
  },
  {
    name: 'Three goals, different deadlines',
    brainDump: 'thesis chapter 3 due next Friday, resume to Priya by Monday, and renew my passport sometime this month',
    expectDeadlines: ['2026-10-09', '2026-10-05', '2026-10-31'],
  },
  {
    name: 'Loose availability (must be ignored)',
    brainDump: 'weekday evenings work but not Wednesday. need to clean my room and finish the DSA assignment by Tuesday',
    expectDeadlines: [null, '2026-10-06'],
  },
  {
    name: 'Already broken down by the user',
    brainDump: 'Portfolio site: 1) pick a template 2) write about page 3) add 3 projects with screenshots 4) deploy to GitHub Pages',
    expectDeadlines: [null],
  },
  {
    name: 'Hinglish input (output must be English)',
    brainDump:
      'kal tak electricity bill pay karna hai, aur weekend pe gym ka routine start karna hai, plus mummy ke liye doctor appointment book karni hai',
    expectDeadlines: ['2026-10-03', '2026-10-04', null],
  },
];
