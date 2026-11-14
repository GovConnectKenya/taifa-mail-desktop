namespace TaifaMail.Core.Net;

public sealed class ApiRequestError : Exception
{
    public int Status { get; }
    public string? Code { get; }

    public ApiRequestError(string message, int status, string? code = null) : base(message)
    {
        Status = status;
        Code = code;
    }

    public bool IsAuth => Status == 401;

    internal ApiRequestError WithInner(Exception e) { Data["inner"] = e.GetType().Name; return this; }
}

/// <summary>The server could not be reached (offline, DNS, TLS, timeout).</summary>
public sealed class ApiTransportError : Exception
{
    public ApiTransportError(string message, Exception? inner = null) : base(message, inner) { }
}
