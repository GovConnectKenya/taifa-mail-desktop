using System.Text.Json;

namespace TaifaMail.Core.ViewModels;

/// <summary>Per user app preferences kept on this machine only (theme, density, notification choices, last mailbox).</summary>
public sealed class LocalSettings
{
    public string Theme { get; set; } = "system";          // system | light | dark
    public string Density { get; set; } = "comfortable";    // comfortable | compact
    public bool NewMailAlerts { get; set; } = true;
    public bool TaskbarBadge { get; set; } = true;
    public string? LastMailboxId { get; set; }
    public string? LastAddress { get; set; }

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static LocalSettings Load(string path)
    {
        try { return File.Exists(path) ? JsonSerializer.Deserialize<LocalSettings>(File.ReadAllText(path)) ?? new() : new(); }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
        File.Move(tmp, path, overwrite: true);
    }
}
