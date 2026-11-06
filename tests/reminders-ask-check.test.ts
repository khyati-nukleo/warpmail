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

describe('askCheck fixes', () => {
  it.each([
    ['Thanks!\nCan you send the invoice?', 'question'],
    ["Merci !\nPouvez-vous m'envoyer la facture ?", 'question'],
    ['Thanks!\nCan you send it', 'phrase'],
    ['Pouvez vous confirmer', 'phrase'],
    ['Peux tu regarder', 'phrase'],
    ['Tenez moi au courant', 'phrase'],
    ['Pouvez\u2010vous confirmer', 'phrase'],
    ['Peux\u2011tu regarder', 'phrase'],
    ['See below?\n\nThanks,\nKim', 'question'],
  ])('asks: %j', (text, reason) => expect(askCheck(text)).toEqual({ asks: true, reason }))

  it.each([
    'Here is the doc: https://docs.example.com/d/abc?usp=sharing',
    'Voir www.example.com/a?b=1',
    'Le mar. 3 nov. 2026 à 10:00, Ada <ada@example.com> a\u00a0écrit :\n> Pouvez-vous ?',
    "Fait.\n-----Message d'origine-----\nDe : Ada\nPouvez-vous ?",
  ])('does not ask: %j', (text) => expect(askCheck(text).asks).toBe(false))

  it('strips a plain closing and the name', () => {
    expect(ownText('Here is the file.\n\nThanks,\nKim')).toBe('Here is the file.')
    expect(ownText('Here is the file.\n\nMerci,\nKim')).toBe('Here is the file.')
    expect(ownText('Here is the file.\n\nBest regards,\nKim')).toBe('Here is the file.')
  })

  it('cuts a wrapped attribution', () =>
    expect(
      ownText('Done.\nLe mar. 3 nov. 2026 à 10:00, Ada <ada@example.com> a écrit :\n> x'),
    ).toBe('Done.'))
})
