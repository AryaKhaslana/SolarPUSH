{
  description = "SolarPUSH / SonarMesh Android + React Native Expo dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          jdk17
          kotlin
          android-tools
        ];
        shellHook = ''
          export JAVA_HOME="${pkgs.jdk17}"
          echo "SolarPUSH devShell ready: Node $(node -v), JDK 17, Kotlin, adb"
        '';
      };
    };
}
