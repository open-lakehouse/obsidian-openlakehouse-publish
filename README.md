# Publish to OpenLakehouse

Obsidian plugin that publishes a note as a blog post on
[openlakehouse.io](https://openlakehouse.io).

openlakehouse.io is a static MDX site with no CMS or write API. Posts live in
the GitHub repository
[`open-lakehouse/openlakehouse-io`](https://github.com/open-lakehouse/openlakehouse-io)
at `src/content/posts/<category>/<slug>/index.mdx`, with images co-located next
to the MDX file. Publishing therefore means: convert the note to MDX, commit it
(and its images) to a branch, and open a pull request. A maintainer reviews and
merges the PR, and the site deploys.

> [!CAUTION]
> This plugin stores your GitHub token unencrypted in the plugin configuration
> file, stored as part of your Obsidian vault. If you don't fully understand the
> implications of this, don't use this plugin. Use a token with the smallest
> possible scope and an expiry date.

## What it does

Run the command **Publish to OpenLakehouse: Create/update OpenLakehouse post**
on the active note. The plugin:

1. Converts the note to MDX (see [Conversion](#conversion)).
2. Picks the repository to push to (the _head repository_): the configured
   head repository; otherwise the target repository if your token can push to
   it; otherwise your fork of the target repository (created if needed).
3. Creates the branch `obsidian/<slug>` from the base branch (default `main`),
   unless it already exists.
4. Writes `index.mdx` and every embedded image to
   `src/content/posts/<category>/<slug>/` on that branch with the GitHub
   Contents API. Unchanged files are skipped.
5. Opens a pull request against the target repository, or reuses the open one.
6. Writes the result back into the note's frontmatter:

   | Key            | Example                                                   |
   | -------------- | --------------------------------------------------------- |
   | `ol-path`      | `src/content/posts/iceberg/my-post/index.mdx`             |
   | `ol-branch`    | `obsidian/my-post`                                        |
   | `ol-pr-url`    | `https://github.com/open-lakehouse/openlakehouse-io/pull/123` |
   | `ol-pr-number` | `123`                                                     |
   | `ol-files`     | every repository path uploaded (index.mdx and images)     |
   | `ol-date`      | `2026-11-23` (only when the note has no `date`, to pin it) |

Running the command again updates the same branch and pull request. If the
pull request was closed or merged, a new one is opened from the same branch.

On re-publish, files the plugin uploaded before (listed in `ol-files`, plus the
`ol-path` index.mdx) that are no longer part of the post are deleted from the
branch: removed images, a removed `thumbnail.*`, and the old directory's files
after a slug or category change. Files the plugin didn't upload are never
deleted.

When publishing from a fork whose base branch is behind the target, the plugin
syncs the fork's base branch (GitHub's "Sync fork") so that new post branches
always start at the target's current base commit. If the fork's base branch
has diverged and can't be synced, publishing stops with an error; sync or reset
the fork on GitHub and try again.

Publishing the same note again while a publish is still running is refused.

## Setup

1. Install the plugin (copy `main.js` and `manifest.json` from a release into
   `<vault>/.obsidian/plugins/publish-to-openlakehouse/`) and enable it.
2. Create a GitHub token:
   - **You have write access to the site repository:** create a
     [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
     with access to `open-lakehouse/openlakehouse-io` and the repository
     permissions **Contents: Read and write** and **Pull requests: Read and
     write**. Leave _Head repository_ empty.
   - **You contribute from a fork:** fork `open-lakehouse/openlakehouse-io`
     on GitHub and set _Head repository_ to `your-user/openlakehouse-io`.
     GitHub does not let fine-grained tokens open pull requests on
     repositories outside the token's resource owner, so in this case use a
     [classic token](https://github.com/settings/tokens/new) with the
     `public_repo` scope. (If _Head repository_ is empty and the token can't
     push to the target, the plugin forks the repository for you, which also
     needs a classic token.)
3. Open the plugin settings and fill in:

   | Setting              | Default                           | Description |
   | -------------------- | --------------------------------- | ----------- |
   | GitHub token         |                                   | Sent as `Authorization: Bearer <token>`. Stored in plain text! |
   | Target repository    | `open-lakehouse/openlakehouse-io` | Repository the pull request is opened against. |
   | Base branch          | `main`                            | Branch posts start from and merge into. |
   | Head repository      | _(empty = auto)_                  | `owner/name` of the repository receiving the branch, e.g. your fork. |
   | Default category     | _(empty)_                         | Category folder when a note has no `ol-category` (e.g. `iceberg`, `delta-lake`, `apache-spark`, `unity-catalog`, `agentic`). |
   | Default author id(s) | _(empty)_                         | Comma separated ids of files in `src/content/authors/` (e.g. `scott-haines`). |
   | Site URL             | `https://openlakehouse.io`        | Used for links between published notes. |

Authors must exist in `src/content/authors/<id>.mdx` in the site repository;
add yourself there (in the same or a separate pull request) if you're new.

## Note frontmatter

The generated post frontmatter follows the site's schema
(`src/content/content.ts`). Each field is read from `ol-<key>` first, then from
the plain `<key>`, so you can keep Obsidian's own use of e.g. `tags` separate
by using `ol-tags`.

| Post field          | Note keys                                   | Default |
| ------------------- | ------------------------------------------- | ------- |
| `title`             | `ol-title`, `title`, else first H1, else file name | |
| `subtitle`          | `ol-subtitle`, `subtitle`                   | omitted |
| `date`              | `ol-date`, `date`                           | today (then pinned as `ol-date`) |
| `authors`           | `ol-authors`, `authors`, `ol-author`, `author` | default author id(s) |
| `excerpt`           | `ol-excerpt`, `excerpt`                     | first paragraph, ~160 characters |
| `tags`              | `ol-tags`, `tags` (a leading `#` is removed) | `[]` |
| `include`           | `ol-include`, `include` (`blog`, `learn`)   | `[blog]` |
| `kind`              | `ol-kind`, `kind` (`post`, `getting-started`, `deep-dive`, `concept`, `tutorial`) | `post` |
| `status`            | `ol-status`, `status` (`published`, `preview`, `draft`) | omitted (= published) |
| `thumbnail`         | `ol-thumbnail`, `thumbnail`                 | omitted |
| `readingTime`, `video`, `originalUrl`, `originalPublisher`, `externalUrl`, `flowDiagram` | `ol-<key>`, `<key>` | omitted |

Where the post goes:

- **Category:** `ol-category`, else the category in `ol-path`, else the default
  category.
- **Slug:** `ol-slug` / `slug`, else the slug in `ol-path`, else the note's file
  name, as kebab-case.

**Thumbnail:** an `https://` URL is written to `thumbnail:` as is. A vault
image (`thumbnail: "[[cover.png]]"`) is uploaded as `thumbnail.<ext>` next to
`index.mdx`, where the site picks it up automatically.

Every other frontmatter key (`aliases`, `cssclasses`, `publish`, the `ol-*`
bookkeeping keys, …) is left out of the post.

## Conversion

- **Title:** when the title comes from the first H1, that heading and anything
  before it are removed from the body (the site renders the title itself).
- **Images:** `![[image.png]]`, `![[image.png|alt text]]` and
  `![alt](relative/image.png)` are uploaded next to `index.mdx` with a safe
  lower-case file name, and rendered the way the site's posts do it:

  ```mdx
  import img0 from "./image.png";

  <img src={img0} alt="alt text" />
  ```

  Remote images (`![](https://…)`) are left alone. Publishing fails if an
  embedded image is not in the vault.
- **Wikilinks:** `[[Other note]]` becomes a link to
  `<site URL>/blog/<category>/<slug>` if the other note has been published
  (it has `ol-path`), and plain text otherwise. Embeds of other notes are
  treated the same way.
- **Comments:** `%%Obsidian comments%%` and `<!-- HTML comments -->` are
  removed.
- **Callouts:** `> [!note] Title` becomes a plain blockquote starting with
  `> **Title**` (or the callout type when there's no title).
- **Autolinks:** `<https://example.com>` (not supported by MDX) becomes
  `[https://example.com](https://example.com)`.
- **Indented code blocks** (not supported by MDX) are converted to fenced code
  blocks with their contents unchanged, also inside lists and blockquotes.
- **MDX escaping:** `{`, `}` and `<` in prose are escaped (`\{`, `\}`,
  `&lt;`), so a note that happens to contain them still compiles. The note is
  parsed as CommonMark + GFM (like Obsidian renders it), and code (including
  fences nested in lists and blockquotes), inline code, link and image
  destinations, reference definitions and bare URLs are left untouched. This also means raw HTML/JSX
  in a note is shown as text rather than rendered.

## Known limitations

- Every file is its own commit (the Contents API writes one file per commit).
  Squash-merging the pull request keeps `main` tidy.
- If the post branch already exists, it is not rebased onto the latest base
  branch.
- Wikilinks to headings link to the post, not to the heading.
- Other Obsidian-only syntax (highlights `==…==`, block references `^id`,
  math) is passed through unchanged; the site does not render math.

## Development

```sh
pnpm install        # or: npx pnpm install
pnpm exec tsc -noEmit -skipLibCheck
pnpm test           # mocha + tsx, includes compiling generated MDX with @mdx-js/mdx
pnpm exec eslint .
node esbuild.config.mjs production
```

`pnpm build` runs all of the above.

## Credits and license

This plugin is a retargeted fork of
[obsidian-dev-publish](https://github.com/stroiman/obsidian-dev-publish)
("Publish to DEV") by **Peter Strøiman**, which publishes notes to
[DEV](https://dev.to). The replace-instruction based markdown processing, the
test fakes for the Obsidian API and the overall plugin structure come from that
project. Thank you, Peter!

Released under the MIT license, see [LICENSE](./LICENSE).
