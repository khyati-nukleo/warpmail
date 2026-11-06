import { describe, expect, it } from 'vitest'
import { askCheck, ownText } from '@inlark/core'

describe('askCheck', () => {
  it.each([
    ['Can we meet Tuesday?', 'question'],
    ['Let me know when it ships.', 'phrase'],
    ['Pouvez-vous envoyer le devis.', 'phrase'],
    ['Merci d’avance pour le retour', 'phrase'],
    ['Thanks in advance', 'phrase'],
    ['Tenez-moi au courant', 'phrase'],
    ['ANY UPDATE on this', 'phrase'],
  ])('asks: %s', (text, reason) => expect(askCheck(text)).toEqual({ asks: true, reason }))

  it.each([
    'Here is the file.\n\nThanks,\nKim',
    'Voici le fichier.\n\nMerci,\nKim',
    'Done.\n\nOn Tue, 3 Nov 2026 at 10:00, Ada <ada@example.com> wrote:\n> Can you send it?',
    'Fait.\n\nLe mar. 3 nov. 2026 à 10:00, Ada <ada@example.com> a écrit :\n> Pouvez-vous ?',
    'Sent.\n-- \nKim · Studio · Need help? Call us',
    'I scan your files daily.',
  ])('does not ask: %j', (text) => expect(askCheck(text).asks).toBe(false))

  it('keeps text above a closing that is not plain', () =>
    expect(ownText('See attached.\n\nThanks in advance,\nKim')).toContain('Thanks in advance'))
})
