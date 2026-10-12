/**
 * @neuroverseos/robot-domain-rules — rules for a physical site where robots
 * and people wearing smart glasses work together.
 *
 *   const builder = new DomainRulesBuilder({ domainId: 'store-1', name: 'Store 1', hours: { open: '08:00', close: '22:00' } });
 *   builder.zone({ zoneId: 'aisle-3', name: 'Aisle 3', kind: 'public' });
 *   builder.role({ roleId: 'floor_robot', name: 'Floor robot', kind: 'robot', actions: ['enter_zone', 'move', 'scan'] });
 *   builder.answer('robots_near_people', 'slow');
 *
 *   const rules = builder.compile();          // plain JSON — save it, ship it to robots and glasses
 *   const decision = evaluateDomainAction(rules, {
 *     participant: { id: 'robot-7', kind: 'robot', roleId: 'floor_robot' },
 *     action: 'move',
 *     zoneId: 'aisle-3',                      // from your spatial system (e.g. posemesh)
 *     facts: { peopleInZone: 2, localTime: '14:05', requestedSpeedMps: 1.0 },
 *   });
 *   // → { status: 'LIMIT', limits: { maxSpeedMps: 0.2 }, reasons: [...], trace: [...], fingerprint }
 *
 * Start with README.md.
 */

export * from './types';
export { DOMAIN_QUESTIONS, defaultDomainAnswers } from './questions';
export type { DomainQuestion, DomainAnswerOption } from './questions';
export {
  compileDomain,
  glassesZoneRules,
  OPEN_ZONE_RULES,
  renderDomainRules,
  fingerprint,
  verifyFingerprint,
  isValidTime,
  DomainRulesError,
  SITE_RULES,
} from './compile';
export type { CompileDomainInput } from './compile';
export { evaluateDomainAction, isOpen } from './evaluate';
export { mergeRules } from './zone-rules';
export type { ZoneRules, ZoneCustomRule } from './zone-rules';

import { DOMAIN_QUESTIONS, defaultDomainAnswers } from './questions';
import { compileDomain, renderDomainRules, DomainRulesError } from './compile';
import type { DomainRole, DomainRuleSet, DomainSite, DomainZone } from './types';

/** Step-by-step way to build a rule set. Same result as calling compileDomain directly. */
export class DomainRulesBuilder {
  private readonly zones: DomainZone[] = [];
  private readonly roles: DomainRole[] = [];
  private readonly answers: Record<string, string> = defaultDomainAnswers();

  constructor(private readonly site: DomainSite) {}

  /** The questions to ask the site operator, with their current answers. */
  get questions() {
    return DOMAIN_QUESTIONS.map(q => ({ ...q, current: this.answers[q.id] }));
  }

  zone(zone: DomainZone): this {
    this.zones.push(zone);
    return this;
  }

  role(role: DomainRole): this {
    this.roles.push(role);
    return this;
  }

  answer(questionId: string, value: string): this {
    const question = DOMAIN_QUESTIONS.find(q => q.id === questionId);
    if (!question) throw new DomainRulesError(`Unknown question "${questionId}".`);
    if (!question.options.some(o => o.value === value)) {
      throw new DomainRulesError(`Invalid answer "${value}" for "${questionId}". Valid: ${question.options.map(o => o.value).join(', ')}`);
    }
    this.answers[questionId] = value;
    return this;
  }

  compile(): DomainRuleSet {
    return compileDomain({ site: this.site, zones: this.zones, roles: this.roles, answers: this.answers });
  }

  /** The compiled rules as plain-English Markdown. */
  preview(): string {
    return renderDomainRules(this.compile());
  }
}
