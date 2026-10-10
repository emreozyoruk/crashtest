import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { structuredCall } from './llm'
import { SCENARIO_MODEL } from './models'

export interface Product {
  name: string
  description: string
  paths: string[]
}

function describeDir(root: string, dir: string): string {
  const pkgPath = join(root, dir, 'package.json')
  if (!existsSync(pkgPath)) return `- ${dir}`
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = Object.keys({ ...pkg.dependencies }).slice(0, 15).join(', ')
    return `- ${dir}: name=${pkg.name ?? '?'}; description=${pkg.description ?? ''}; scripts=${Object.keys(pkg.scripts ?? {}).join(',')}; deps=${deps}`
  } catch {
    return `- ${dir}`
  }
}

// Groups package directories into user-facing products, so a frontend + backend pair counts
// as one product while separate apps in a monorepo are offered as a choice.
export async function groupProducts(root: string, dirs: string[]): Promise<Product[]> {
  const result = await structuredCall<{ products: Product[] }>({
    model: SCENARIO_MODEL,
    system:
      'You classify the packages of a repository into user-facing products. A product is something an end user ' +
      'uses (a web app, an API, a mobile app, a CLI). A frontend and the backend that serves it are ONE product. ' +
      'Shared libraries, configs, UI kits and type packages are not products; attach them to nothing.',
    prompt: `Packages in this repository:\n${dirs.map((d) => describeDir(root, d)).join('\n')}`,
    toolName: 'report_products',
    schema: {
      type: 'object',
      properties: {
        products: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short human name, e.g. "Admin dashboard"' },
              description: { type: 'string', description: 'One sentence' },
              paths: { type: 'array', items: { type: 'string' }, description: 'Package directories belonging to it' }
            },
            required: ['name', 'description', 'paths']
          }
        }
      },
      required: ['products']
    },
    maxTokens: 2000
  })
  return result.products.filter((p) => p.paths.length > 0)
}
