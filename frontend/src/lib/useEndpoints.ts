import { useEffect, useState } from 'react'
import type { EndpointKind } from '@shared/types'

/** Display name of a project's endpoint: its own choice, else the first one of the kind. */
export function useEndpointName(kind: EndpointKind, id: string | null | undefined): string {
  const fallback = kind === 'llm' ? 'endpoint LLM' : kind === 'image' ? 'endpoint gambar' : 'endpoint video'
  const [name, setName] = useState(fallback)
  useEffect(() => {
    let live = true
    void window.api.endpoints.list(kind).then((eps) => {
      if (!live) return
      const ep = eps.find((e) => e.id === id) ?? eps[0]
      if (ep) setName(ep.name)
    })
    return () => {
      live = false
    }
  }, [kind, id])
  return name
}
