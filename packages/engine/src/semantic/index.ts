/**
 * Semantic analysis: Module 3 of the course, chapters 5 and 6 of the Dragon Book.
 *
 * Every function here is pure and takes text or plain data. Everything it returns is plain data
 * too, with no class instances or Maps, so results and traces can cross a Web Worker boundary. A
 * trace is an array of { title, explanation, state }, and a Player can step through one directly.
 *
 * Bad input throws EngineError, and attempt() from core/result turns that into a Result. Errors in
 * a definition have codes starting sdd_spec_, with a position in the definition's text. Errors in
 * the input have codes starting sdd_input_, with a position in the input's text. The type checker
 * and typeInfer treat a type error as a normal result, not as a throw, because finding those is
 * what they are for. Only bad syntax throws there.
 *
 * ------ Attribute grammars ------
 *
 * The format is one production per entry, with rules in braces. E1 is an occurrence of E, and T1'
 * of T'. ε, epsilon or nothing at all means an empty body. | starts another alternative. Comments
 * start with #. digit, num and number match any number token. id and identifier match any name.
 * Anything else matches its own text, and quotes make a terminal of a character like {.
 *
 *   const spec = `
 *     L -> E n     { L.val = E.val }
 *     E -> E1 + T  { E.val = E1.val + T.val }
 *     E -> T       { E.val = T.val }
 *     T -> T1 * F  { T.val = T1.val * F.val }
 *     T -> F       { T.val = F.val }
 *     F -> ( E )   { F.val = E.val }
 *     F -> digit   { F.val = digit.lexval }`;
 *
 * sddAnalyze(specText): the definition and its classification, with no input needed.
 *   sddAnalyze(spec).classification.kind            // 's-attributed'
 *   sddAnalyze(spec).classification.reason          // the reason, as a sentence
 *   sddAnalyze(spec).classification.checks          // the verdict and reason for each rule
 *
 * sddEvaluate(specText, input): the whole pipeline, with a trace.
 *   const run = sddEvaluate(spec, '3 * 5 + 4 n');
 *   run.nodes, run.root                             // the parse tree: flat, preorder, by id
 *   run.attrs, run.edges                            // the dependency graph
 *   run.order, run.cycle                            // the topological order, or one cycle
 *   run.values[attr.id]                             // an attribute's value. L.val is 19 here.
 *   run.effects, run.problems                       // side effects, and attributes with no value
 *   run.trace                                       // phases: parse, graph, order, evaluate, finished
 * In a step, attrCount and edgeCount say how much of attrs and edges exists yet.
 *
 * ------ Translation schemes ------
 *
 * sdtAnalyze(specText): each action and when it fires. It also gives the grammar with markers.
 *   sdtAnalyze("E -> T R \n R -> + T { print('+') } R1 | ε \n T -> num { print(num.val) }")
 *
 * sdtRun(specText, input, mode): plays a bottom-up or top-down parser over the tree.
 *   const run = sdtRun(sdtText, '9 + 5 + 2', 'bottom-up');   // or 'top-down'
 *   run.output                                      // ['9', '5', '+', '2', '+']
 *   run.fired                                       // action ids, in firing order
 *   run.trace                                       // event, stack, consumed, remaining, output
 *
 * ------ Symbol tables ------
 *
 * Three organizations run the same operations: 'hash' (chaining), 'tree' (a BST) and 'stack'.
 *
 * symtabParseScript(text): operations from lines like "enter", "insert x int", "lookup x", "exit".
 * symtabOperationsFromBlocks(source): operations from a block-structured program.
 *   const ops = symtabOperationsFromBlocks('{ int x; char y; { bool y; x; y; } x; y; }');
 *
 * symtabRun(organization, operations, options): the structure at each step.
 *   symtabRun('hash', ops, { buckets: 7 }).trace    // state.structure is one of three shapes,
 *                                                   // told apart by state.structure.organization
 * symtabCompare(operations, options): comparisons per operation, for all three.
 *   symtabCompare(ops).rows, symtabCompare(ops).totals
 *
 * ------ Type expressions ------
 *
 * typeExprParse(text): 'array(10, pointer(int))', 'int * float -> bool', 'record { x: int }', 'list(α)'.
 * typeExprFormat(type): back to text, as the book prints it, like int × float → bool.
 * typeExprWidth(type, env): the width in bytes. int is 4 and float is 8.
 * typeEnvParse(text): declarations, one per line, like "link = pointer(cell)".
 *
 * typeEquivalent(left, right, mode, env): 'structural' or 'name', with a trace.
 *   const env = typeEnvParse('link = pointer(cell)\ncell = record { info: int; next: link }');
 *   typeEquivalent(typeExprParse('link'), typeExprParse('pointer(cell)'), 'structural', env).equivalent  // true
 *   typeEquivalent(typeExprParse('link'), typeExprParse('pointer(cell)'), 'name', env).equivalent        // false
 * typeIsEquivalent(left, right, mode, env): the same answer with no trace.
 *
 * Coercion, from the book's widening hierarchy:
 *   TYPE_WIDENING_EDGES                             // [['byte', 'short'], ...]
 *   typeMaxOf('int', 'float')                       // 'float'
 *   typeWideningPath('char', 'long')                // ['char', 'int', 'long']
 *   typeConversionKind('float', 'int')              // 'narrowing'
 *   typeCoercionTable()                             // every pair, for a table
 *
 * ------ Type checker ------
 *
 * tcParse(source): the mini-language's AST. It looks like a small C, with struct, if, while and
 * functions. Assignment is a statement.
 * tcCheck(source): the stepper.
 *   const run = tcCheck('int x; float y; y = x + 2.5; x = y;');
 *   run.ok, run.errors                              // false, with a narrowing error and its location
 *   run.coercions                                   // conversions inserted, like (float) x
 *   run.nodeTypes                                   // each expression's type, by node id
 *   run.trace                                       // node, text, span, type, rule, coercions,
 *                                                   // errors, scopes
 *
 * ------ Type inference ------
 *
 * typeInfer(source): inference over a small functional language, as the book does it.
 *   const run = typeInfer('fun length(x) = if null(x) then 0 else length(tl(x)) + 1');
 *   run.definitions                                 // [{ name: 'length', type: '∀α. list(α) → int' }]
 *   run.rows                                        // the book's table: expression, type, unify
 *   run.trace                                       // unifications and bindings at each step
 * Predefined names: null, tl, hd, cons, nil. [] is the empty list. fn(x) => e is a function.
 *
 * typeUnify(left, right): unification alone, with occurs check. Failing is a normal result.
 *   typeUnify(typeExprParse('list(α) → α'), typeExprParse('β → int')).bindings
 */
export * from './sdd-expr';
export * from './sdd-spec';
export * from './sdd-classify';
export * from './sdd-parse';
export * from './sdd-eval';
export * from './sdt';
export * from './symbol-table';
export * from './type-expr';
export * from './type-relations';
export * from './tc-parser';
export * from './type-checker';
export {
  typeUnify,
  type TypeBinding,
  type TypeUnifyAction,
  type TypeUnifyResult,
  type TypeUnifyStep,
} from './unify';
export * from './inference';
