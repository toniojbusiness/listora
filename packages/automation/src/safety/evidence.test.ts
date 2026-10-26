import { describe, expect, it } from 'vitest';

import { dataSkeleton, reducedPath, reducedWords, redactEvidence } from './evidence.ts';

const context = { cookieDomains: ['.poshmark.com'], typed: ['Trucker jacket'] };

describe('page evidence', () => {
  it('keeps the structure of a page and none of whose page it is', () => {
    const evidence = redactEvidence(
      {
        path: '/closet/janedoe',
        title: "Jane Doe's Closet | Poshmark",
        testIds: ['UserMenu', 'listing-5f3a9c0e1b2d4e6f7a8b9c0d', null, 'UserMenu'],
        links: [
          { path: '/closet/janedoe', et: 'my_closet', testId: 'UserMenu', label: 'Jane Doe' },
          { path: '/logout', et: null, testId: null, label: null },
        ],
        requests: [
          'https://poshmark.com/vm-rest/users/5f3a9c0e1b2d4e6f7a8b9c0d/profile?x=1',
          'https://api.poshmark.com/v1/api?operationName=viewerQuery&variables=%7B%7D',
          'https://www.google-analytics.com/collect?uid=janedoe',
        ],
        scripts: [{ id: '__NEXT_DATA__', type: 'application/json' }],
        controls: [
          { tag: 'input', type: 'file', names: [['id', 'img-file-input']], text: null },
          {
            tag: 'input',
            type: 'text',
            names: [
              ['data-vv-name', 'title'],
              ['placeholder', 'What are you selling, Jane?'],
            ],
            text: null,
          },
          { tag: 'button', type: null, names: [['data-et-name', 'list']], text: 'List' },
        ],
        choices: [
          'Women',
          'Tops & blouses',
          'Ships from 94110',
          'jane@example.com',
          'New With Tags',
        ],
      },
      {
        __INITIAL_STATE__: {
          auth: { isUserLoggedIn: true, identity: { username: 'janedoe', display_handle: 'Jane' } },
          title: 'Trucker jacket',
        },
      },
      context,
    );
    expect(evidence).toEqual({
      path: '/closet/<x>',
      title: '<x> <x> Closet | Poshmark',
      testIds: ['UserMenu', 'listing-<id>'],
      links: ['/closet/<x> et:my_closet testid:UserMenu label:<x> <x>', '/logout'],
      requests: [
        'poshmark.com/vm-rest/users/<x>/profile',
        'api.poshmark.com/v1/api?operationName=viewerQuery',
        '+1 elsewhere',
      ],
      scripts: ['#__NEXT_DATA__ application/json'],
      controls: [
        'input[file] id:img-file-input',
        'input[text] data-vv-name:title placeholder:<x> are you selling, <x>',
        'button data-et-name:list text:List',
      ],
      choices: ['Women', 'Tops & blouses', 'New With Tags'],
      data: [
        '__INITIAL_STATE__: object',
        '__INITIAL_STATE__.auth: object',
        '__INITIAL_STATE__.auth.isUserLoggedIn: true',
        '__INITIAL_STATE__.auth.identity: object',
        '__INITIAL_STATE__.auth.identity.username: string',
        '__INITIAL_STATE__.auth.identity.display_handle: string',
        '__INITIAL_STATE__.title: string',
      ],
    });
    const logged = JSON.stringify(evidence);
    for (const personal of ['janedoe', 'Jane', 'Doe', 'Trucker', '5f3a9c0e']) {
      expect(logged).not.toContain(personal);
    }
  });

  it('follows only the parts of the data that say who is signed in, and keys records by <key>', () => {
    expect(
      dataSkeleton('__NEXT_DATA__', {
        page: '/mypage/[[...slug]]',
        buildId: 'abc',
        props: {
          pageProps: { viewer: { id: 12, isGuest: false }, items: [{ title: 'x' }] },
          users: { janedoe: { name: 'Jane' }, other: { name: 'Sam' } },
        },
      }),
    ).toEqual([
      '__NEXT_DATA__: object',
      '__NEXT_DATA__.page: "/mypage/<x>"',
      '__NEXT_DATA__.buildId: string',
      '__NEXT_DATA__.props: object',
      '__NEXT_DATA__.props.pageProps: object',
      '__NEXT_DATA__.props.pageProps.viewer: object',
      '__NEXT_DATA__.props.pageProps.viewer.id: number',
      '__NEXT_DATA__.props.pageProps.viewer.isGuest: false',
      '__NEXT_DATA__.props.users: object',
      '__NEXT_DATA__.props.users.<key>: object',
      '__NEXT_DATA__.props.users.<key>.name: string',
    ]);
  });

  it('keeps structural words in paths and titles, and nothing else', () => {
    expect(reducedPath('/create-listing')).toBe('/create-listing');
    expect(reducedPath('/mypage/listings/active/')).toBe('/mypage/listings/active/');
    expect(reducedPath('/us/item/m12345678901/')).toBe('/us/item/<x>/');
    expect(reducedWords('Just a moment...')).toBe('Just a moment...');
    expect(reducedWords('Sell on Poshmark')).toBe('Sell on Poshmark');
    expect(reducedWords('sam@example.com')).toBe('<x>');
  });

  it('is none for a page that answered something else', () => {
    expect(redactEvidence('nope', {}, context)).toBeNull();
  });
});
