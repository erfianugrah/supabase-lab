import Markdown from 'react-markdown'

// Replies can quote knowledge-base text, which the kit treats as untrusted, so
// render formatting only: no links, no images (an image URL is fetched on
// render, which can carry data out), no raw HTML. Disallowed elements keep
// their text; an image has none and is dropped. reply-markdown.test.tsx holds
// the hostile cases.
export const REPLY_ELEMENTS = ['p', 'strong', 'em', 'ul', 'ol', 'li', 'code', 'br']

export function ReplyMarkdown({ text }: { text: string }) {
  return (
    <Markdown allowedElements={REPLY_ELEMENTS} unwrapDisallowed skipHtml>
      {text}
    </Markdown>
  )
}
