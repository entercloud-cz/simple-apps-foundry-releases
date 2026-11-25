using System.ComponentModel.DataAnnotations;

namespace App;

// Request and response types of the API. Validation attributes are checked
// automatically (AddValidation in Program.cs); invalid input gets a 400.

public sealed record EchoRequest([Required, StringLength(500, MinimumLength = 1)] string Message);
