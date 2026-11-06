import { describe, expect, it } from 'vitest'
import type { Address } from '../packages/core/src'
import { recipientSuggestions } from '../apps/desktop/src/renderer/src/recipient-suggestions'

const person = (email: string, name = ''): Address => ({ name, email })
const mail = (from: Address[], to: Address[] = [], cc: Address[] = []) => ({ from, to, cc })
const emails = (addresses: Address[]) => addresses.map((a) => a.email)

describe('recipient suggestions', () => {
  it('never suggests a no-reply address sent under your own name', () => {
    const conversations = [
      {
        messages: [
          mail([person('noreply@github.com', 'Me Example')], [person('me@example.com')]),
          mail([person('noreply@github.com', 'Me Example')], [person('me@example.com')]),
        ],
      },
    ]
    expect(recipientSuggestions(conversations, ['me@example.com'])).toEqual([])
  })

  it.each([
    'noreply@example.com',
    'no-reply@example.com',
    'no_reply@example.com',
    'No.Reply@example.com',
    'NOREPLY@example.com',
    'do-not-reply@example.com',
    'donotreply@example.com',
    'do_not_reply@example.com',
    'noreply+abc@example.com',
    'no-reply-aws@amazon.com',
    'postmaster@microsoft.com',
    'Postmaster@example.com',
    'mailer-daemon@googlemail.com',
    'MAILER-DAEMON@example.com',
    'bounce@example.com',
    'bounces@lists.example.com',
    'bounces+abc=example.com@mailchimp.com',
    'bounce-123@example.com',
    'Bounce_Back@example.com',
    'b.o.u.n.c.e.s@example.com',
  ])('leaves out %s, which cannot receive mail', (email) => {
    const conversations = [{ messages: [mail([person(email, 'Somebody')])] }]
    expect(recipientSuggestions(conversations, [])).toEqual([])
  })

  it.each([
    'notifications@github.com',
    'info@example.com',
    'nora@example.com',
    'replies@example.com',
    'postmaster.jones@example.com',
    'bob@example.com',
    'bounty@example.com',
    'jbounce@example.com',
  ])('keeps %s, which may be a real person or inbox', (email) => {
    const conversations = [{ messages: [mail([person(email)])] }]
    expect(emails(recipientSuggestions(conversations, []))).toEqual([email])
  })

  it('excludes your own addresses regardless of case', () => {
    const conversations = [
      { messages: [mail([person('Me@Example.com', 'Me')], [person('sam@example.com')])] },
    ]
    expect(emails(recipientSuggestions(conversations, ['me@example.com']))).toEqual([
      'sam@example.com',
    ])
  })

  it('ranks people you hear from most first and prefers a named entry', () => {
    const conversations = [
      { messages: [mail([person('ana@example.com')], [person('sam@example.com')])] },
      {
        messages: [
          mail([person('sam@example.com', 'Sam Lee')], [], [person('ana@example.com')]),
          mail([person('SAM@example.com')]),
        ],
      },
    ]
    expect(recipientSuggestions(conversations, [])).toEqual([
      person('sam@example.com', 'Sam Lee'),
      person('ana@example.com'),
    ])
  })
})
