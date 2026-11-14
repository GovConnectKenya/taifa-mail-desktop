using TaifaMail.Core.Content;

namespace TaifaMail.Core.Tests;

public class LinkSafetyTests
{
    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("file:///c:/windows/system32")]
    [InlineData("ftp://x.example")]
    [InlineData("data:text/html,hi")]
    [InlineData("not a url")]
    [InlineData("")]
    public void Only_http_https_mailto_are_allowed(string url) => Assert.False(LinkSafety.Check(url).Allowed);

    [Fact] public void Https_link_reports_real_host() =>
        Assert.Equal("example.go.ke", LinkSafety.Check("https://Example.go.ke/path?q=1").DisplayHost);

    [Fact] public void Punycode_host_is_decoded_for_display() =>
        Assert.Equal("m\u00fcnchen.example", LinkSafety.Check("https://xn--mnchen-3ya.example/").DisplayHost);

    [Fact] public void Visible_text_naming_another_host_is_flagged()
    {
        Assert.True(LinkSafety.Check("https://evil.example/login", "https://bank.example.go.ke").HostDiffersFromText);
        Assert.True(LinkSafety.Check("https://evil.example/login", "bank.example.go.ke").HostDiffersFromText);
    }

    [Fact] public void Matching_or_non_host_text_is_not_flagged()
    {
        Assert.False(LinkSafety.Check("https://www.example.go.ke/a", "example.go.ke").HostDiffersFromText);
        Assert.False(LinkSafety.Check("https://evil.example/", "Click here").HostDiffersFromText);
        Assert.False(LinkSafety.Check("https://evil.example/", null).HostDiffersFromText);
    }

    [Fact] public void Mailto_is_allowed_with_domain()
    {
        var c = LinkSafety.Check("mailto:ada@example.go.ke?subject=Hi");
        Assert.True(c.Allowed);
        Assert.Equal("example.go.ke", c.DisplayHost);
    }
}

public class HtmlBodyTests
{
    private static readonly BodyColors C = new("#050100", "#006900");

    [Fact] public void Csp_blocks_scripts_and_remote_images_by_default()
    {
        var doc = HtmlBody.Wrap("<p>hi</p>", false, false, C);
        Assert.Contains("script-src &#39;none&#39;", doc.Replace("'", "&#39;"));
        Assert.Contains("img-src data: cid:;", doc);
        Assert.DoesNotContain("https:", doc.Split("<style>")[0]);
    }

    [Fact] public void Allowing_images_opens_img_src_only()
    {
        var doc = HtmlBody.Wrap("<p>hi</p>", true, false, C);
        Assert.Contains("img-src data: cid: https: http:", doc);
        Assert.Contains("default-src &#39;none&#39;", doc.Replace("'", "&#39;"));
    }

    [Fact] public void Dark_mode_sets_color_scheme_and_base_font()
    {
        var doc = HtmlBody.Wrap("x", false, true, new BodyColors("#F8F3F0", "#1EA94E"));
        Assert.Contains("color-scheme:dark", doc);
        Assert.Contains("font:14px/22px", doc);
        Assert.Contains("background:transparent", doc);
    }

    [Fact] public void Plain_text_links_are_found_without_trailing_punctuation()
    {
        var text = "see https://example.go.ke/a, and (https://x.example/b).";
        var links = HtmlBody.FindLinks(text);
        Assert.Equal(2, links.Count);
        Assert.Equal("https://example.go.ke/a", text.Substring(links[0].Start, links[0].Length));
        Assert.Equal("https://x.example/b", text.Substring(links[1].Start, links[1].Length));
    }
}
