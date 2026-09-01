/**
 * Public surface of the rule engine.
 *
 * One compiler, one operator table, one set of error messages; each domain
 * supplies its own field catalogue and nothing else.
 */
export {
  LIST_OPERATORS,
  OPERATORS_BY_TYPE,
  VALUELESS_OPERATORS,
  createRuleEngine,
  parseRules,
} from './engine.js'
export type {
  CompiledRules,
  RuleCondition,
  RuleEngine,
  RuleFieldMeta,
  RuleFieldType,
  RuleSet,
} from './engine.js'
