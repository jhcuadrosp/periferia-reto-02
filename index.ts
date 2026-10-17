
interface Usuario {
    nombre: string;
    reto: number;
}

function saludar(usuario: Usuario): string {
    return `Hola ${usuario.nombre}, bienvenido al Reto ${usuario.reto} de Periferia IT Group`;
}

const usuario: Usuario = {
    nombre: "Javier",
    reto: 2
};

console.log(saludar(usuario));
