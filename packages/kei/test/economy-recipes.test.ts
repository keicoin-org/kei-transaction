/**
 * `defineRecipe()` reads no chain, so everything it can catch it catches at
 * import — which is the point of a declaration. These tests never open a node.
 */

import { describe, expect, test } from 'bun:test'
import { KeiError, defineRecipe, defineRecipes } from 'kei-transaction'

const GAME = 'kei_3t8myo6xnh84mqegoxp383b7mmdgbt6aqwmbfz6y6tfj45by5q6gsi6mgiu3'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof KeiError) return error.code
    throw error
  }
  throw new Error('expected a KeiError, and nothing was thrown')
}

describe('the three shapes, derived from costs and grants', () => {
  test('grants alone is a reward', () => {
    const recipe = defineRecipe({ id: 'daily', grants: [{ asset: 'KEI', amount: 0.5 }] })
    expect(recipe.strategy).toBe('grant')
    expect(recipe.costs).toEqual([])
  })

  test('costs alone is a sink, and a sink burns by default', () => {
    const recipe = defineRecipe({ id: 'repair', costs: [{ asset: { symbol: 'GEM' }, amount: 5 }] })
    expect(recipe.strategy).toBe('sink')
    expect(recipe.sink).toBe('burn')
  })

  test('one of each is an exchange, and its costs necessarily go to the issuer', () => {
    const recipe = defineRecipe({
      id: 'forge',
      costs: [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
      grants: [{ asset: { symbol: 'SWORD' } }],
    })
    expect(recipe.strategy).toBe('exchange')
    expect(recipe.sink).toBe('issuer')
  })

  test('a recipe that costs nothing and grants nothing would write no blocks', () => {
    expect(codeOf(() => defineRecipe({ id: 'nothing' }))).toBe('empty-recipe')
    expect(codeOf(() => defineRecipe({ id: 'nothing', costs: [], grants: [] }))).toBe('empty-recipe')
  })
})

describe('what a swap cannot do is refused where it is written, not where it runs', () => {
  test('three ingredients for one sword has no block that could settle it', () => {
    let thrown: KeiError | undefined
    try {
      defineRecipe({
        id: 'forge-sword',
        costs: [{ asset: 'IRON' }, { asset: 'WOOD' }, { asset: 'COAL' }],
        grants: [{ asset: 'SWORD' }],
      })
    } catch (error) {
      thrown = error as KeiError
    }
    expect(thrown?.code).toBe('not-one-block')
    // The refusal is only useful if it names the two ways out.
    expect(thrown?.message).toContain('one asset each way')
    expect(thrown?.message).toContain('price the recipe in one currency')
    expect(thrown?.message).toContain('split it into a sink recipe')
  })

  test('one cost for two grants is the same problem the other way round', () => {
    expect(
      codeOf(() =>
        defineRecipe({ id: 'bundle', costs: [{ asset: 'KEI', amount: 1 }], grants: [{ asset: 'A' }, { asset: 'B' }] }),
      ),
    ).toBe('not-one-block')
  })

  test("a recipe that grants cannot also burn what it costs — the swap hands them over", () => {
    let thrown: KeiError | undefined
    try {
      defineRecipe({
        id: 'trade-in',
        costs: [{ asset: 'SCRAP', amount: 10 }],
        grants: [{ asset: 'GEM' }],
        sink: 'burn',
      })
    } catch (error) {
      thrown = error as KeiError
    }
    expect(thrown?.code).toBe('bad-sink')
    expect(thrown?.message).toContain('token.burn()')
  })

  test('many grants and no costs is allowed — nobody is paying, so nobody can be short-changed', () => {
    const recipe = defineRecipe({ id: 'starter', grants: [{ asset: 'A' }, { asset: 'B' }, { asset: 'C' }] })
    expect(recipe.strategy).toBe('grant')
    expect(recipe.grants).toHaveLength(3)
  })

  test('many costs and no grants is allowed for the same reason', () => {
    const recipe = defineRecipe({ id: 'toll', costs: [{ asset: 'A' }, { asset: 'B' }] })
    expect(recipe.strategy).toBe('sink')
  })
})

describe('the shape of a recipe', () => {
  test('an id is required, because it is how two halves of a game agree', () => {
    expect(codeOf(() => defineRecipe({ id: '', grants: [{ asset: 'A' }] }))).toBe('bad-recipe')
    expect(codeOf(() => defineRecipe({ id: '   ', grants: [{ asset: 'A' }] }))).toBe('bad-recipe')
    expect(codeOf(() => defineRecipe(undefined as never))).toBe('bad-recipe')
  })

  test('the name defaults to the id, and the id is trimmed', () => {
    expect(defineRecipe({ id: '  daily  ', grants: [{ asset: 'A' }] }).name).toBe('daily')
    expect(defineRecipe({ id: 'daily', name: 'Daily Bonus', grants: [{ asset: 'A' }] }).name).toBe('Daily Bonus')
  })

  test('an amount defaults to one, which is the item case', () => {
    const recipe = defineRecipe({ id: 'drop', grants: [{ asset: 'SWORD' }] })
    expect(recipe.grants[0]?.amount).toBe(1)
  })

  test('amounts must be positive, whatever they are written as', () => {
    // `'.'` and `'+'` are the ones a shape check alone lets through: they match
    // the pattern of a decimal, and `Number()` answers NaN, which is not `<= 0`.
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0', '-3', 'lots', '', '.', '+', '+.', '  ']) {
      expect(codeOf(() => defineRecipe({ id: 'bad', grants: [{ asset: 'A', amount: amount as never }] }))).toBe(
        'bad-amount',
      )
    }
  })

  test('a decimal string amount survives, because a number would not', () => {
    const recipe = defineRecipe({ id: 'fee', costs: [{ asset: 'KEI', amount: '0.000000000000000001' }] })
    expect(recipe.costs[0]?.amount).toBe('0.000000000000000001')
  })

  test('an asset has to be named somehow', () => {
    expect(codeOf(() => defineRecipe({ id: 'x', grants: [{ asset: '' }] }))).toBe('bad-asset')
    expect(codeOf(() => defineRecipe({ id: 'x', grants: [{ asset: {} as never }] }))).toBe('bad-asset')
    expect(codeOf(() => defineRecipe({ id: 'x', grants: [{ asset: { symbol: '  ' } }] }))).toBe('bad-asset')
    expect(codeOf(() => defineRecipe({ id: 'x', grants: [undefined as never] }))).toBe('bad-stack')
  })

  test('costs, grants and requires must be arrays', () => {
    expect(codeOf(() => defineRecipe({ id: 'x', grants: { asset: 'A' } as never }))).toBe('bad-recipe')
    expect(codeOf(() => defineRecipe({ id: 'x', costs: 'GEM' as never }))).toBe('bad-recipe')
  })

  test('an issuer, if given, is a real address', () => {
    expect(defineRecipe({ id: 'x', grants: [{ asset: 'A' }], issuer: GAME }).issuer).toBe(GAME)
    expect(codeOf(() => defineRecipe({ id: 'x', grants: [{ asset: 'A' }], issuer: 'not-an-address' }))).toBe(
      'bad-address',
    )
  })

  test("sink is 'burn' or 'issuer' and nothing else", () => {
    expect(codeOf(() => defineRecipe({ id: 'x', costs: [{ asset: 'A' }], sink: 'delete' as never }))).toBe('bad-sink')
  })

  test('a recipe is frozen, so nothing can retune the price after it is declared', () => {
    const recipe = defineRecipe({ id: 'shop', costs: [{ asset: 'KEI', amount: 5 }], grants: [{ asset: 'GEM' }] })
    expect(Object.isFrozen(recipe)).toBe(true)
    expect(Object.isFrozen(recipe.costs)).toBe(true)
    expect(Object.isFrozen(recipe.costs[0])).toBe(true)
    expect(() => {
      ;(recipe as { id: string }).id = 'other'
    }).toThrow()
  })
})

describe('a catalogue', () => {
  test('defineRecipes keys them by id', () => {
    const catalogue = defineRecipes([
      { id: 'daily', grants: [{ asset: 'GEM', amount: 10 }] },
      { id: 'repair', costs: [{ asset: 'GEM', amount: 2 }] },
    ])
    expect([...catalogue.keys()]).toEqual(['daily', 'repair'])
    expect(catalogue.get('daily')?.strategy).toBe('grant')
  })

  test('two recipes with one id is the bug an id exists to prevent', () => {
    expect(
      codeOf(() =>
        defineRecipes([
          { id: 'daily', grants: [{ asset: 'GEM' }] },
          { id: 'daily', grants: [{ asset: 'GOLD' }] },
        ]),
      ),
    ).toBe('duplicate-recipe')
  })

  test('defineRecipes takes an array, and says so when it does not get one', () => {
    expect(codeOf(() => defineRecipes({ id: 'daily' } as never))).toBe('bad-recipe')
  })
})
