import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from '@/ui/utils/markdown';

describe('Markdown', () => {
  it('renders explicit links as clickable anchors that open in a new tab', () => {
    render(
      <Markdown source="See [the docs](https://example.com) for more." />,
    );
    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('auto-links bare http(s) URLs', () => {
    render(<Markdown source="visit https://example.org now" />);
    const link = screen.getByRole('link', { name: 'https://example.org' });
    expect(link).toHaveAttribute('href', 'https://example.org');
  });

  it('refuses to render unsafe protocols as links', () => {
    render(
      <Markdown source="click [bad](javascript:alert(1)) here" />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/bad/)).toBeInTheDocument();
  });

  it('renders https markdown images', () => {
    render(<Markdown source="![Diagram](https://example.com/diagram.png)" />);
    const image = screen.getByRole('img', { name: 'Diagram' });
    expect(image).toHaveAttribute('src', 'https://example.com/diagram.png');
  });

  it('resolves local image tokens through resolver', () => {
    render(
      <Markdown
        source="![Dungeon artifact](local:att-123)"
        resolveLocalImage={(attachmentId) =>
          attachmentId === 'att-123' ? 'file:///tmp/artifact.png' : null
        }
      />,
    );
    const image = screen.getByRole('img', { name: 'Dungeon artifact' });
    expect(image).toHaveAttribute('src', 'file:///tmp/artifact.png');
  });

  it('shows missing-image placeholder for unresolved local image tokens', () => {
    render(<Markdown source="![Dungeon artifact](local:att-missing)" />);
    expect(
      screen.getByText(/Missing image \(att-missing\)\. Reattach it or remove this token\./i),
    ).toBeInTheDocument();
  });

  it('renders headings, bold, italic, code, and bullet lists', () => {
    render(
      <Markdown
        source={'# Title\n\nThis is **bold** and *italic* and `code`.\n\n- one\n- two'}
      />,
    );
    expect(screen.getByText('Title').closest('h3')).not.toBeNull();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
