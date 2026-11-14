using System.Net;
using System.Text;

namespace TaifaMail.Core.Compose;

public enum ListKind { None, Bullet, Numbered }

public sealed record ComposeRun(string Text, bool Bold = false, bool Italic = false, string? Link = null);

public sealed record ComposeParagraph(IReadOnlyList<ComposeRun> Runs, ListKind List = ListKind.None);

/// <summary>Turns the editor's paragraphs into the HTML and plain text alternative the API sends.</summary>
public static class ComposeHtml
{
    public static string ToHtml(IReadOnlyList<ComposeParagraph> paragraphs, string? quotedHtml = null, string? quoteHeader = null)
    {
        var sb = new StringBuilder();
        var open = ListKind.None;
        void CloseList() { if (open != ListKind.None) { sb.Append(open == ListKind.Bullet ? "</ul>" : "</ol>"); open = ListKind.None; } }
        foreach (var p in paragraphs)
        {
            if (p.List != open)
            {
                CloseList();
                if (p.List != ListKind.None) { sb.Append(p.List == ListKind.Bullet ? "<ul>" : "<ol>"); open = p.List; }
            }
            var inner = new StringBuilder();
            foreach (var r in p.Runs)
            {
                if (r.Text.Length == 0) continue;
                var t = WebUtility.HtmlEncode(r.Text).Replace("\n", "<br>").Replace("\v", "<br>");
                if (r.Bold) t = "<strong>" + t + "</strong>";
                if (r.Italic) t = "<em>" + t + "</em>";
                if (IsSafeLink(r.Link)) t = $"<a href=\"{WebUtility.HtmlEncode(r.Link!)}\">{t}</a>";
                inner.Append(t);
            }
            if (p.List != ListKind.None) sb.Append("<li>").Append(inner).Append("</li>");
            else sb.Append("<div>").Append(inner.Length == 0 ? "<br>" : inner.ToString()).Append("</div>");
        }
        CloseList();
        if (!string.IsNullOrEmpty(quotedHtml))
        {
            sb.Append("<br><div>").Append(WebUtility.HtmlEncode(quoteHeader ?? "")).Append("</div>");
            sb.Append("<blockquote style=\"margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex\">").Append(quotedHtml).Append("</blockquote>");
        }
        return sb.ToString();
    }

    public static string ToText(IReadOnlyList<ComposeParagraph> paragraphs, string? quotedText = null, string? quoteHeader = null)
    {
        var sb = new StringBuilder();
        var n = 0;
        foreach (var p in paragraphs)
        {
            var text = string.Concat(p.Runs.Select(r => r.Text)).Replace("\v", "\n");
            if (p.List == ListKind.Numbered) { n++; sb.Append(n).Append(". "); } else n = 0;
            if (p.List == ListKind.Bullet) sb.Append("- ");
            sb.Append(text).Append('\n');
        }
        if (!string.IsNullOrEmpty(quotedText))
        {
            sb.Append('\n').Append(quoteHeader).Append('\n');
            foreach (var line in quotedText.Replace("\r\n", "\n").Split('\n')) sb.Append("> ").Append(line).Append('\n');
        }
        return sb.ToString().TrimEnd('\n') + "\n";
    }

    public static bool IsSafeLink(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme is "http" or "https" or "mailto");
}
