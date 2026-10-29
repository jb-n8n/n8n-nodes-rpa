namespace ErpDemo;

/// <summary>The sign-in window. Control names are the UI Automation automation ids.</summary>
internal sealed class LoginForm : Form
{
    public const string User = "clerk";
    public const string Password = "demo1234";

    private readonly UiVersion _ui;
    private readonly TextBox _user;
    private readonly TextBox _password;
    private readonly Label _error;

    public LoginForm(UiVersion ui)
    {
        _ui = ui;
        Name = "LoginForm";
        Text = "ERP Demo - Sign in";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(360, 190);
        Font = new Font("Segoe UI", 9f);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 4, Padding = new Padding(16) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        layout.Controls.Add(new Label { Name = "lblUser", Text = "User name", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
        _user = new TextBox { Name = "txtUser", AccessibleName = "User name", Dock = DockStyle.Fill, TabIndex = 0 };
        layout.Controls.Add(_user, 1, 0);

        layout.Controls.Add(new Label { Name = "lblPassword", Text = "Password", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 1);
        _password = new TextBox { Name = "txtPassword", AccessibleName = "Password", UseSystemPasswordChar = true, Dock = DockStyle.Fill, TabIndex = 1 };
        layout.Controls.Add(_password, 1, 1);

        _error = new Label { Name = "lblLoginError", Text = "", AutoSize = true, ForeColor = Color.Firebrick };
        layout.Controls.Add(_error, 1, 2);

        var signIn = new Button { Name = "btnSignIn", Text = "Sign in", AutoSize = true, TabIndex = 2, Anchor = AnchorStyles.Right };
        signIn.Click += (_, _) => SignIn();
        layout.Controls.Add(signIn, 1, 3);
        AcceptButton = signIn;

        Controls.Add(layout);
    }

    private void SignIn()
    {
        if (_user.Text != User || _password.Text != Password)
        {
            _error.Text = "User name or password is wrong.";
            _password.Clear();
            return;
        }
        var main = new MainForm(_ui, _user.Text);
        main.FormClosed += (_, _) => Close();
        main.Show();
        Hide();
    }
}
