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
