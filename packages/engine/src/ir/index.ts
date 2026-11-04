/**
 * Intermediate code: Module 4 of the course, chapter 6 of the Dragon Book, plus basic blocks from
 * chapter 8, dominators from chapter 9, and SSA.
 *
 * Every function here is pure and returns plain data, so results and traces can cross a Web Worker
 * boundary. A trace is an array of { title, explanation, state }. Bad input throws EngineError, and
 * attempt() from core/result turns that into a Result. Syntax errors have the code ir_syntax and a
 * position in the source.
 *
 * ------ The language ------
 *
 * irParse(source): the AST, as plain data. Each node has id, start and end. The language has
 * declarations, assignment, arithmetic, comparisons, && || ! (also and, or, not), if, if-else,
 * while, array references, function calls, switch, break and return. The closing ; is optional at
 * the very end, and any expression can be a statement, so a lone expression is a valid program.
 * Arrays need a declaration for their widths, unless they have one index, when int is assumed.
 *   irParse('int a[2][3]; x = c + a[i][j];').body
 *
 * ------ Three-address code ------
 *
 * irToTac(source): the code, in the shared TacInstr form from ./types, with a trace.
 *   const run = irToTac('a = b*-c + b*-c');
 *   run.code                                        // TacInstr[]
 *   run.text                                        // ['t1 = -c', 't2 = b * t1', 't3 = -c',
 *                                                   //  't4 = b * t3', 't5 = t2 + t4', 'a = t5']
 *   run.symbols                                     // declarations, with width and offset
 *   run.trace                                       // node, text, span, rule, addr, labels,
 *                                                   // emitted, emittedFrom, codeLength
 * irProgramToTac(program): the same, for an AST from irParse.
 *
 * TacInstr has no "if x < y goto L", so a comparison in a condition becomes t1 = x < y, then
 * if t1 goto L. Labels and jumps otherwise follow figures 6.36 and 6.37. Case values in a switch
 * have the same two-step form. irBackpatch keeps the book's one-instruction form.
 *
 * ------ Postfix ------
 *
 * irToPostfix(source):
 *   irToPostfix('a = b*-c + b*-c').text             // 'a b c uminus * b c uminus * + ='
 *   irToPostfix(source).trace                       // appended, tokenCount, at each node
 *
 * ------ Quadruples, triples, indirect triples ------
 *
 * irBuildTables(code, indirectStart): all three tables, from any TacInstr list.
 * irSourceToTables(source, indirectStart): the same, from source text.
 *   const tables = irSourceToTables('a = b*-c + b*-c');
 *   tables.quadruples                               // { index, op, arg1, arg2, result }
 *   tables.triples                                  // { index, op, arg1, arg2, instruction }
 *   tables.indirect                                 // { position, triple }, with position from 35
 *
 * ------ DAG ------
 *
 * irBuildDag(source): the value-number method, then code from the DAG. Assignments and expressions
 * only. Control flow, arrays and calls throw ir_dag_unsupported.
 *   const run = irBuildDag('a = b*-c + b*-c');
 *   run.records                                     // { valueNumber, op, left, right, leaf, labels }
 *   run.reusedCount                                 // how often Leaf or Node found an existing row
 *   run.text                                        // ['t1 = -c', 't2 = b * t1', 't3 = t2 + t2', 'a = t3']
 *   run.trace                                       // phase, action, call, records, variables, emitted
 *
 * ------ Backpatching ------
 *
 * irBackpatch(source, firstInstruction): figures 6.43 and 6.46, with makelist, merge and backpatch
 * each as a step. Instructions are numbered from 100 unless told otherwise.
 *   const run = irBackpatch('a < b or c < d and e < f');
 *   run.mode                                        // 'boolean'
 *   run.instructions.map((instr) => instr.text)     // 100: if a < b goto _ , 101: goto 102,
 *                                                   // 102: if c < d goto 104, 103: goto _,
 *                                                   // 104: if e < f goto _, 105: goto _
 *   run.truelist, run.falselist                     // [100, 104], [103, 105]
 *   run.trace                                       // operation, call, production, instructions,
 *                                                   // nextinstr, list, target, changed, attributes
 * With statements, mode is 'statements', every blank gets filled, and leftover exits go to the
 * instruction after the last one. A step's attributes are the lists on each AST node, as in figure 6.45.
 *
 * ------ Basic blocks and the flow graph ------
 *
 * irPartitionBlocks(code): the leader rules, then blocks and edges, from any TacInstr list.
 * irSourceToCfg(source): the same, from source text.
 *   const run = irSourceToCfg('while (i < n) i = i + 1;');
 *   run.leaders                                     // { index, rule, reason }
 *   run.cfg.blocks, run.cfg.edges                   // { id, start, end, code, text, labels, rule }
 *   run.cfg.nodes, run.cfg.successors, run.cfg.predecessors      // with ENTRY and EXIT
 *   run.trace                                       // phase, leaders, blockCount, edgeCount
 *
 * ------ Dominators ------
 *
 * irDominators(cfg): iterative dominators, then immediate dominators, the tree and frontiers.
 *   const doms = irDominators(run.cfg);
 *   doms.dominators.B2, doms.idom.B2, doms.tree.B1, doms.frontier.B3
 *   doms.reachable, doms.unreachable
 *   doms.trace                                      // phase, iteration, node, rows, idom, frontier
 *
 * ------ SSA ------
 *
 * irToSsa(code, options): phi placement by iterated dominance frontier, then renaming.
 * irSourceToSsa(source, options): the same, from source text. { pruned: true } skips dead phis.
 *   const ssa = irSourceToSsa('if (flag) x = -1; else x = 1; y = x * a;');
 *   ssa.phis                                        // [{ block: 'B5', variable: 'x' }]
 *   ssa.blocks                                      // { id, code, text }. B5 has x₃ = φ(B3: x₁, B4: x₂).
 *   ssa.cfg, ssa.dominators                         // what it worked from
 *   ssa.trace                                       // phase, block, variable, worklist, phis, stacks, blocks
 * Names use subscript digits, so x₁ cannot clash with a variable named x1.
 */
export * from './types';
export * from './parser';
export * from './symbols';
export * from './tac-gen';
export * from './postfix';
export * from './tables';
export * from './dag';
export * from './backpatch';
export * from './cfg';
export * from './dominators';
export * from './ssa';
