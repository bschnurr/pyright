import { ConstraintSet, ConstraintTracker } from '../analyzer/constraintTracker';
import { AnyType, TypeVarType, UnknownType } from '../analyzer/types';

test('CloneWithSignatureReusesMatchingSetsWithoutCloning', () => {
    const first = new ConstraintSet();
    first.addScopeId('match');
    const other = new ConstraintSet();
    other.addScopeId('other');
    const last = new ConstraintSet();
    last.addScopeId('match');
    const tracker = new ConstraintTracker();
    tracker.addConstraintSets([first, other, last, first]);
    const clone = jest.spyOn(ConstraintSet.prototype, 'clone');

    try {
        const result = tracker.cloneWithSignature('match');
        expect(result).not.toBe(tracker);
        expect(result.getConstraintSets()).not.toBe(tracker.getConstraintSets());
        expect(result.getConstraintSets()).toHaveLength(3);
        expect(result.getConstraintSet(0)).toBe(first);
        expect(result.getConstraintSet(1)).toBe(last);
        expect(result.getConstraintSet(2)).toBe(first);
        expect(tracker.getConstraintSets()).toEqual([first, other, last, first]);
        expect(clone).not.toHaveBeenCalled();
    } finally {
        clone.mockRestore();
    }
});

test.each(['new', ''])('CloneWithSignatureClonesUnmatchedSets scope=%s', (scopeId) => {
    const variable = TypeVarType.createInstance('Value');
    const bound = AnyType.create();
    const first = new ConstraintSet();
    first.addScopeId('existing');
    first.setBounds(variable, bound, undefined, true);
    const second = new ConstraintSet();
    const tracker = new ConstraintTracker();
    tracker.addConstraintSets([first, second]);

    const result = tracker.cloneWithSignature(scopeId);
    expect(result.getConstraintSets()).toHaveLength(2);
    expect(result.getConstraintSet(0)).not.toBe(first);
    expect(result.getConstraintSet(1)).not.toBe(second);
    expect(result.getConstraintSet(0).getTypeVar(variable)).not.toBe(first.getTypeVar(variable));
    expect(result.getConstraintSet(0).getTypeVar(variable)).toEqual(first.getTypeVar(variable));
    expect(result.getConstraintSet(0).hasScopeId('existing')).toBe(true);
    expect(result.getConstraintSet(0).hasScopeId(scopeId)).toBe(!!scopeId);
    expect(result.getConstraintSet(1).hasScopeId(scopeId)).toBe(!!scopeId);
    expect(first.hasScopeId(scopeId)).toBe(false);
    expect(second.hasScopeId(scopeId)).toBe(false);

    result.getConstraintSet(0).getTypeVar(variable)!.lowerBound = UnknownType.create();
    result.getConstraintSet(0).addScopeId('independent');
    expect(first.getTypeVar(variable)!.lowerBound).toBe(bound);
    expect(first.hasScopeId('independent')).toBe(false);
});

test.each(['getTypeVar', 'getTypeVars', 'doForEachTypeVar'] as const)(
    'ConstraintSetCloneIsolatesEscapedEntries %s',
    (accessor) => {
        const variable = TypeVarType.createInstance('Value');
        const bound = AnyType.create();
        const replacement = UnknownType.create();
        for (const exposeBeforeClone of [false, true]) {
            const source = new ConstraintSet();
            source.setBounds(variable, bound, undefined, true);
            const expose = () => {
                if (accessor === 'getTypeVar') {
                    return source.getTypeVar(variable)!;
                }
                if (accessor === 'getTypeVars') {
                    return source.getTypeVars()[0];
                }
                let entry;
                source.doForEachTypeVar((value) => {
                    entry = value;
                });
                return entry!;
            };
            const escaped = exposeBeforeClone ? expose() : undefined;
            const cloned = source.clone();
            const sibling = source.clone();
            (escaped ?? expose()).lowerBound = replacement;
            expect(cloned.getTypeVar(variable)!.lowerBound).toBe(bound);
            expect(sibling.getTypeVar(variable)!.lowerBound).toBe(bound);
            cloned.getTypeVar(variable)!.retainLiterals = false;
            expect(source.getTypeVar(variable)!.retainLiterals).toBe(true);
            expect(sibling.getTypeVar(variable)!.retainLiterals).toBe(true);
        }
    }
);

test('ConstraintSetCloneSharesUntilMutation', () => {
    const variable = TypeVarType.createInstance('Value');
    const bound = AnyType.create();
    const replacement = UnknownType.create();
    const source = new ConstraintSet();
    source.setBounds(variable, bound);
    source.addScopeId('original');
    const setBounds = jest.spyOn(ConstraintSet.prototype, 'setBounds');
    let cloned: ConstraintSet;
    try {
        cloned = source.clone();
        expect(setBounds).not.toHaveBeenCalled();
    } finally {
        setBounds.mockRestore();
    }
    const sibling = cloned.clone();
    source.setBounds(variable, replacement);
    cloned.addScopeId('clone');
    source.addScopeId('source');
    expect(cloned.getTypeVar(variable)!.lowerBound).toBe(bound);
    expect(sibling.getTypeVar(variable)!.lowerBound).toBe(bound);
    expect(source.getTypeVar(variable)!.lowerBound).toBe(replacement);
    expect([...sibling.getScopeIds()]).toEqual(['original']);
    sibling.getScopeIds().add('external');
    expect(sibling.hasScopeId('external')).toBe(false);
    expect([...cloned.getScopeIds()]).toEqual(['original', 'clone']);
    expect([...source.getScopeIds()]).toEqual(['original', 'source']);
});

test('ConstraintSetCloneDuringIterationPreservesLiveIteration', () => {
    const first = TypeVarType.createInstance('First');
    const second = TypeVarType.createInstance('Second');
    const bound = AnyType.create();
    const source = new ConstraintSet();
    source.setBounds(first, bound);
    const visited: string[] = [];
    let cloned: ConstraintSet | undefined;
    source.doForEachTypeVar((entry) => {
        visited.push(entry.typeVar.shared.name);
        if (entry.typeVar === first) {
            cloned = source.clone();
            source.setBounds(second, bound);
            entry.lowerBound = UnknownType.create();
        }
    });
    expect(visited).toEqual(['First', 'Second']);
    expect(cloned!.getTypeVar(first)!.lowerBound).toBe(bound);
    expect(cloned!.getTypeVar(second)).toBeUndefined();
});

test('ConstraintSetCloneRekeysMutatedTypeVarScope', () => {
    const variable = TypeVarType.createInstance('Value');
    variable.priv.scopeId = 'before';
    variable.priv.nameWithScope = 'Value.before';
    const source = new ConstraintSet();
    const bound = AnyType.create();
    source.setBounds(variable, bound);
    variable.priv.scopeId = 'after';
    variable.priv.nameWithScope = 'Value.after';
    const cloned = source.clone();
    expect(source.getTypeVar(variable)).toBeUndefined();
    expect(cloned.getTypeVar(variable)!.lowerBound).toBe(bound);
});
